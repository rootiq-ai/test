require([
    'jquery',
    'underscore',
    'splunkjs/mvc',
    'splunkjs/mvc/searchmanager',
    'splunkjs/mvc/simplexml/ready!'
], function($, _, mvc, SearchManager) {

    // Prevent double initialization (SimpleXML can fire require callback twice)
    if (window._AF_LOADED) { console.log('[AF] Already loaded, skipping duplicate init.'); return; }
    window._AF_LOADED = true;

    console.log('[AF] ======= Alerting Framework v4 loaded =======');

    // ============================================================
    // BULLETPROOF REST FOR SPLUNK 9.x
    // ============================================================
    var _locale = window.location.pathname.split('/')[1] || 'en-US';

    // Get current logged-in Splunk username
    function _getUsername() {
        try { if (window.$C && window.$C.USERNAME) return window.$C.USERNAME; } catch(e) {}
        try { return Splunk.util.getConfigValue('USERNAME'); } catch(e) {}
        // Parse from the nav bar "Administrator" link
        try { var t = $('.account .username, [data-username]').text(); if (t) return t.trim(); } catch(e) {}
        return 'nobody';
    }
    var _currentUser = _getUsername();
    console.log('[AF] Locale: ' + _locale + ' | User: ' + _currentUser);

    function _csrf() {
        var cks = document.cookie.split(';');
        for (var i = 0; i < cks.length; i++) {
            var c = cks[i].replace(/^\s+/, '');
            if (c.indexOf('splunkweb_csrf_token_') === 0) return c.substring(c.indexOf('=') + 1);
        }
        var $inp = $('input[name="splunk_form_key"]');
        if ($inp.length && $inp.val()) return $inp.val();
        try { if (window.$C && window.$C.FORM_KEY) return window.$C.FORM_KEY; } catch(e) {}
        try { return Splunk.util.getFormKey(); } catch(e) {}
        return '';
    }

    console.log('[AF] Locale: ' + _locale + ' | CSRF: ' + (_csrf() ? 'OK' : 'MISSING'));

    function _rest(method, endpoint, params, cb) {
        var token = _csrf();
        var url = '/' + _locale + '/splunkd/__raw' + endpoint;
        console.log('[AF] REST: ' + method + ' ' + url);
        var ajaxOpts = {
            url: url, type: method,
            headers: { 'X-Splunk-Form-Key': token, 'X-Requested-With': 'XMLHttpRequest' },
            timeout: 30000
        };
        if (method === 'GET') {
            ajaxOpts.data = params || {};
        } else if (method === 'POST') {
            ajaxOpts.data = params || {};
        } else if (method === 'DELETE') {
            if (url.indexOf('?') === -1) ajaxOpts.url += '?output_mode=json';
            else ajaxOpts.url += '&output_mode=json';
        }
        $.ajax(ajaxOpts)
        .done(function(data, ts, xhr) { console.log('[AF] ✓ ' + method + ' ' + endpoint); if (cb) cb(null, data); })
        .fail(function(xhr) {
            console.error('[AF] ✗ ' + method + ' ' + endpoint + ' => HTTP ' + xhr.status);
            console.error('[AF] Body: ' + (xhr.responseText || '').substring(0, 300));
            var msg = 'HTTP ' + xhr.status;
            try { msg = JSON.parse(xhr.responseText).messages[0].text; } catch(e) {
                try { var m = xhr.responseText.match(/<msg[^>]*>([^<]+)<\/msg>/); if (m) msg = m[1]; } catch(e2) {}
            }
            if (cb) cb({ status: xhr.status, message: msg });
        });
    }

    // ---- STATE ----
    var isAcknowledged = false, macrosList = [], templatesList = [];
    var editRestPath = ''; // Stores exact REST path from entry.id when editing

    // ---- LOOKUP LOADERS ----
    function loadLookupDropdown(lookupName, valueField, labelField, selectId, defaultOption) {
        var s = new SearchManager({
            id: 'lkp_' + lookupName + '_' + Date.now(),
            search: '| inputlookup ' + lookupName + '.csv | dedup ' + valueField + ' | sort ' + valueField,
            earliest_time: '-1m', latest_time: 'now'
        });
        s.on('search:done', function() {
            var r = s.data('results');
            if (r) r.on('data', function() {
                var rows = r.data().rows || [], fl = r.data().fields || [];
                var vi = fl.indexOf(valueField), li = fl.indexOf(labelField || valueField);
                var $sel = $('#' + selectId);
                // Keep the first default option
                var firstOpt = $sel.find('option:first').clone();
                $sel.empty().append(firstOpt);
                rows.forEach(function(row) {
                    var val = row[vi] || '', lbl = row[li] || val;
                    var desc = labelField ? ' — ' + lbl : '';
                    $sel.append('<option value="' + val + '">' + val + (desc ? desc : '') + '</option>');
                });
                // Add "New Event Class" option for event class dropdown
                if (selectId === 'fld_eventclass') {
                    $sel.append('<option value="__new__">+ New Event Class...</option>');
                }
                if (defaultOption) $sel.val(defaultOption);
                console.log('[AF] Loaded lookup ' + lookupName + ' → #' + selectId + ' (' + rows.length + ' items)');
            });
        });
        s.on('search:error', function() {
            console.error('[AF] Failed to load lookup: ' + lookupName);
        });
        s.startSearch();
    }

    function loadAllLookups() {
        loadLookupDropdown('application_names', 'app_name', 'description', 'fld_app_name');
        loadLookupDropdown('event_classes', 'event_class', 'description', 'fld_eventclass');
        loadLookupDropdown('assignment_groups', 'assignment_group', 'description', 'fld_assignment');
        loadLookupDropdown('org_codes', 'org_code', 'description', 'fld_orgcode');
    }

    // ---- NEW EVENT CLASS HANDLER ----
    $(document).on('change', '#fld_eventclass', function() {
        if ($(this).val() === '__new__') {
            $('#fld_eventclass_custom').show().focus().val('');
        } else {
            $('#fld_eventclass_custom').hide().val('');
        }
        resetAcknowledge();
        updateSummary();
    });
    $(document).on('input', '#fld_eventclass_custom', function() {
        resetAcknowledge();
        updateSummary();
    });

    // Helper: get resolved event class value
    function getEventClassValue() {
        var v = $('#fld_eventclass').val();
        if (v === '__new__') return $.trim($('#fld_eventclass_custom').val());
        return v || '';
    }

    // ---- URL PARAMS ----
    function getUrlParam(name) {
        var match = RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search);
        return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : null;
    }

    // ============================================================
    // CUSTOM TIME PICKER (tp-*) — pure jQuery, zero SDK dependency
    // ============================================================
    function setDuration(earliest, latest, label) {
        $('#fld_dur_e').val(earliest);
        $('#fld_dur_l').val(latest);
        $('#tp-label').text(label);
        $('.tp-opt').removeClass('tp-opt-sel');
        $('.tp-opt').each(function() {
            if (String($(this).data('e')) === String(earliest) && String($(this).data('l')) === String(latest))
                $(this).addClass('tp-opt-sel');
        });
        $('#tp-menu').hide();
        console.log('[AF] Duration set: ' + earliest + ' → ' + latest + ' (' + label + ')');
        resetAcknowledge();
        updateSummary();
    }

    function getDur() {
        return { earliest: $('#fld_dur_e').val() || '-15m', latest: $('#fld_dur_l').val() || 'now' };
    }
    function getDurLabel() { return $('#tp-label').text() || 'Last 15 minutes'; }

    // Toggle menu
    $(document).on('click', '#tp-btn', function(e) {
        e.preventDefault(); e.stopPropagation();
        $('#tp-menu').toggle();
    });
    // Close on outside click
    $(document).on('click', function(e) {
        if (!$(e.target).closest('#tp-wrap').length) $('#tp-menu').hide();
    });
    // Accordion toggle
    $(document).on('click', '.tp-acc-head', function() {
        var sec = $(this).data('sec');
        var $body = $('.tp-acc-body[data-sec="' + sec + '"]');
        var wasOpen = $body.is(':visible');
        // Close all
        $('.tp-acc-body').slideUp(150);
        $('.tp-acc-head').removeClass('tp-acc-open').find('.tp-arrow').html('&#9656;');
        // Open clicked if was closed
        if (!wasOpen) {
            $body.slideDown(150);
            $(this).addClass('tp-acc-open').find('.tp-arrow').html('&#9662;');
        }
    });
    // Preset click
    $(document).on('click', '.tp-opt', function(e) {
        e.preventDefault();
        setDuration(String($(this).data('e')), String($(this).data('l')), $(this).text().trim());
    });
    // Relative Apply
    $(document).on('click', '#tp-rel-apply', function() {
        var num = parseInt($('#tp-rel-num').val()) || 15;
        var unit = $('#tp-rel-unit').val() || 'm';
        var snap = $('input[name="tp-snap"]:checked').val() || 'none';
        var lat = $('input[name="tp-lat"]:checked').val() || 'now';
        var earliest = '-' + num + unit;
        if (snap !== 'none') earliest += snap;
        var units = {m:'minutes',h:'hours',d:'days',w:'weeks',mon:'months'};
        setDuration(earliest, lat, 'Last ' + num + ' ' + (units[unit]||unit));
    });
    // Date Range Apply (with time)
    $(document).on('click', '#tp-date-apply', function() {
        var from = $('#tp-date-from').val(), to = $('#tp-date-to').val();
        var timeFrom = $('#tp-time-from').val() || '00:00';
        var timeTo = $('#tp-time-to').val() || '23:59';
        if (!from) return;
        var earliestStr = from + 'T' + timeFrom + ':00';
        var latestStr = to ? to + 'T' + timeTo + ':59' : 'now';
        var label = from + ' ' + timeFrom + ' to ' + (to ? to + ' ' + timeTo : 'now');
        setDuration(earliestStr, latestStr, label);
    });
    // Advanced Apply
    $(document).on('click', '#tp-adv-apply', function() {
        var e = $.trim($('#tp-adv-e').val()) || '-15m';
        var l = $.trim($('#tp-adv-l').val()) || 'now';
        setDuration(e, l, e + ' to ' + l);
    });

    // ---- BUILD FULL QUERY ----
    function buildFullQuery() {
        var q = $.trim($('#fld_query').val()), parts = [];
        parts.push('email_subject="' + $.trim($('#fld_subject').val()).replace(/"/g,'\\"') + '"');
        parts.push('email_body="' + $.trim($('#fld_body').val()).replace(/"/g,'\\"') + '"');
        return q + ' | eval ' + parts.join(', ');
    }

    // ---- ERRORS ----
    function showErr(id,m) { $('#fld_'+id).addClass('input-error'); $('#err_'+id).text(m).show(); }
    function hideErr(id) { $('#fld_'+id).removeClass('input-error'); $('#err_'+id).text('').hide(); }
    function hideAllErrors() { $('.input-error').removeClass('input-error'); $('[id^="err_"]').text('').hide(); $('#form-errors').hide().text(''); }
    function chkEmail(e) { return e && /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test($.trim(e)); }

    function validateAll() {
        hideAllErrors(); var errs = [], tk = $('#fld_ticket').val()==='yes';
        if (!$.trim($('#fld_alert_name').val())) { showErr('alert_name','Required'); errs.push('Alert Name'); }
        if (!$.trim($('#fld_app_name').val())) { showErr('app_name','Required'); errs.push('App Name'); }
        if (tk && !getEventClassValue()) { showErr('eventclass','Required'); errs.push('Event Class'); }
        if (tk && !$.trim($('#fld_assignment').val())) { showErr('assignment','Required'); errs.push('Assignment'); }
        if (tk && !$.trim($('#fld_orgcode').val())) { showErr('orgcode','Required'); errs.push('Org Code'); }
        if (!$.trim($('#fld_query').val())) { showErr('query','Required'); errs.push('Query'); }
        var em = $.trim($('#fld_email').val());
        if (!em) { showErr('email','Required'); errs.push('Email'); }
        else { var bad=[]; em.split(',').forEach(function(e){ e=$.trim(e); if(e&&!chkEmail(e)) bad.push(e); }); if(bad.length){ showErr('email','Invalid: '+bad.join(', ')); errs.push('Email'); } }
        if (!$.trim($('#fld_subject').val())) { showErr('subject','Required'); errs.push('Subject'); }
        if (!$.trim($('#fld_body').val())) { showErr('body','Required'); errs.push('Body'); }
        if ($('#fld_frequency').val()==='custom' && !$.trim($('#fld_custom_cron').val())) errs.push('Cron');
        if (errs.length) { $('#form-errors').html('<strong>Fix:</strong> ' + errs.join(', ')).show(); return false; }
        return true;
    }

    function toggleTicketFields() {
        $('#fld_ticket').val()==='yes' ? $('#ticket-fields-container').slideDown(200) : ($('#ticket-fields-container').slideUp(200), hideErr('eventclass'), hideErr('assignment'), hideErr('orgcode'));
        updateSummary();
    }

    // ---- SUMMARY ----
    // Inject missing summary rows once
    var _summaryInjected = false;
    function injectSummaryRows() {
        if (_summaryInjected) return;
        _summaryInjected = true;
        var rowStyle = 'font-weight:600; color:#555; padding:6px 0; width:120px;';
        // Find the Ticket row and add after it
        var $ticketRow = $('#sum-ticket').closest('tr');
        if ($ticketRow.length) {
            var rows = '';
            rows += '<tr id="sum-eventclass-row" style="display:none;"><td style="' + rowStyle + '">Event Class:</td><td id="sum-eventclass">-</td></tr>';
            rows += '<tr id="sum-assignment-row" style="display:none;"><td style="' + rowStyle + '">Assignment Group:</td><td id="sum-assignment">-</td></tr>';
            rows += '<tr id="sum-orgcode-row" style="display:none;"><td style="' + rowStyle + '">Org Code:</td><td id="sum-orgcode">-</td></tr>';
            $ticketRow.after(rows);
        }
        // Hide Query row and add id
        $('#sum-query').closest('tr').attr('id', 'sum-query-row').hide();
        // Add Email Subject and Email Body rows after Email row
        var $emailRow = $('#sum-email').closest('tr');
        if ($emailRow.length) {
            var eRows = '';
            eRows += '<tr id="sum-subject-row"><td style="' + rowStyle + '">Email Subject:</td><td id="sum-subject">-</td></tr>';
            eRows += '<tr id="sum-body-row"><td style="' + rowStyle + '">Email Body:</td><td id="sum-body">-</td></tr>';
            $emailRow.after(eRows);
        }
    }

    function updateSummary() {
        injectSummaryRows();
        $('#sum-name').text($('#fld_alert_name').val()||'-');
        $('#sum-app').text($('#fld_app_name').val()||'-');
        $('#sum-ticket').text($('#fld_ticket').val()==='yes'?'Yes':'No');
        $('#sum-email').text($('#fld_email').val()||'-');
        $('#sum-subject').text($('#fld_subject').val()||'-');
        $('#sum-body').text($('#fld_body').val()||'-');
        $('#sum-priority').text($('#fld_priority').val()||'-');
        if ($('#fld_ticket').val()==='yes') {
            $('#sum-eventclass-row').show(); $('#sum-eventclass').text(getEventClassValue()||'-');
            $('#sum-assignment-row').show(); $('#sum-assignment').text($('#fld_assignment').val()||'-');
            $('#sum-orgcode-row').show(); $('#sum-orgcode').text($('#fld_orgcode').val()||'-');
        } else {
            $('#sum-eventclass-row,#sum-assignment-row,#sum-orgcode-row').hide();
        }
        $('#sum-duration').text(getDurLabel());
        var fv=$('#fld_frequency').val(), ft=$('#fld_frequency option:selected').text();
        if(fv==='custom'){var c=$.trim($('#fld_custom_cron').val()); ft=c?'Custom: '+c:'Custom';}
        $('#sum-frequency').text(ft);
        $('#sum-threshold').text($('#fld_threshold').val()||'0');
        $('#sum-trigger').text($('#fld_trigger').val()==='for_each_result'?'For each result':'Once');
        var st='None'; if($('#fld_throttle').is(':checked')){ var sv=parseInt($('#fld_suppression').val())||0, su=$('#fld_suppression_unit').val(); st=sv+' '+(su==='s'?'sec':su==='m'?'min':'hr')+'(s)'; }
        $('#sum-suppression').text(st);
        $('#sum-query-row').hide();
        $('#btn-ack').prop('disabled',!($.trim($('#fld_alert_name').val())&&$.trim($('#fld_query').val())));
    }

    // ---- MACROS ----
    function loadMacros() {
        $('#macros-container').html('Loading...');
        var s=new SearchManager({id:'mac_'+Date.now(), search:'| rest /servicesNS/-/-/admin/macros splunk_server=local | table title definition | head 30', earliest_time:'-1m', latest_time:'now'});
        s.on('search:done',function(){var r=s.data('results');if(r)r.on('data',function(){
            var rows=r.data().rows||[],f=r.data().fields||[]; macrosList=[];
            if(!rows.length){$('#macros-container').html('<p>No macros</p>');return;}
            var h=''; rows.forEach(function(row){var n=row[f.indexOf('title')]||'',d=row[f.indexOf('definition')]||''; macrosList.push({name:n,def:d});
            h+='<div style="padding:8px;margin-bottom:8px;background:#f5f5f5;border-radius:4px;overflow:hidden;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;"><code style="color:#1976d2;font-size:11px;">`'+n+'`</code><button class="btn btn-default btn-xs btn-insert-macro" data-name="'+n+'">Insert</button></div><div style="font-size:10px;color:#666;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+(d.length>50?d.substring(0,50)+'...':d)+'</div></div>';});
            $('#macros-container').html(h);
        });});
        s.on('search:error',function(){$('#macros-container').html('<p style="color:red;">Error</p>');}); s.startSearch();
    }

    // ---- TEMPLATES ----
    function loadTemplates() {
        $('#templates-container').html('Loading...');
        var s=new SearchManager({id:'tpl_'+Date.now(), search:'| inputlookup alert_templates.csv', earliest_time:'-1m', latest_time:'now'});
        s.on('search:done',function(){var r=s.data('results');if(r)r.on('data',function(){
            var rows=r.data().rows||[],fl=r.data().fields||[]; templatesList=[];
            if(!rows.length){$('#templates-container').html('<p>No templates</p>');return;}
            var h=''; rows.forEach(function(row,i){
                var t={};['name','description','priority','frequency','frequency_label','ticket','event_class','assignment_group','org_code','threshold','suppression','duration','email','subject_prefix','email_body','query'].forEach(function(k){t[k]=row[fl.indexOf(k)]||'';});
                if(!t.priority)t.priority='P3';if(!t.frequency)t.frequency='*/15 * * * *';if(!t.subject_prefix)t.subject_prefix='[ALERT]'; templatesList.push(t);
                var pc=t.priority==='P1'?'#c62828':t.priority==='P2'?'#f57c00':t.priority==='P3'?'#1976d2':'#388e3c';
                h+='<div style="padding:8px;margin-bottom:8px;background:#f5f5f5;border-radius:4px;border-left:3px solid '+pc+';overflow:hidden;"><div style="display:flex;justify-content:space-between;align-items:center;gap:5px;"><span style="font-weight:bold;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+t.name+'</span><span style="display:flex;align-items:center;gap:5px;flex-shrink:0;"><span style="color:'+pc+';font-weight:bold;font-size:11px;">('+t.priority+')</span><button class="btn btn-primary btn-xs btn-apply-template" data-idx="'+i+'" style="padding:2px 8px;">Apply</button></span></div><div style="font-size:10px;color:#666;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px;">'+t.description+'</div></div>';
            }); $('#templates-container').html(h);
        });});
        s.on('search:error',function(){$('#templates-container').html('<p style="color:red;">Error</p>');}); s.startSearch();
    }

    // ---- PREVIEW ----
    function runPreview() {
        var q=buildFullQuery(), t=getDur();
        $('#preview-query').text(q); $('#preview-status').text('Running...').css('color','#1976d2'); $('#preview-results').html('Searching...');
        var smId = 'prev_'+Date.now();
        var sm=new SearchManager({id:smId, search:q+' | head 20', earliest_time:t.earliest, latest_time:t.latest, preview:false, autostart:false});
        var st=new Date();
        // Attach results listener BEFORE starting search
        var resultsModel = sm.data('results', {output_mode:'json_rows', count:20});
        resultsModel.on('data', function() {
            var elapsed = ((new Date()-st)/1000).toFixed(1);
            $('#preview-time').text(elapsed+'s');
            try {
                var data = resultsModel.data();
                var rows = data.rows || [];
                var flds = data.fields || [];
                $('#preview-status').text('Complete').css('color','#2e7d32');
                $('#preview-count').text(rows.length);
                if (!rows.length) { $('#preview-results').html('<p>No results found.</p>'); return; }
                var h='<div style="overflow-x:auto;"><table class="table table-striped" style="font-size:12px;"><thead><tr>';
                flds.forEach(function(f){h+='<th>'+f+'</th>';});
                h+='</tr></thead><tbody>';
                rows.slice(0,20).forEach(function(row){
                    h+='<tr>';
                    flds.forEach(function(f,c){var v=row[c]||'';h+='<td>'+(String(v).length>100?String(v).substring(0,100)+'...':v)+'</td>';});
                    h+='</tr>';
                });
                h+='</tbody></table></div>';
                $('#preview-results').html(h);
            } catch(err) {
                console.error('[AF] Preview results error:', err);
                $('#preview-status').text('Error parsing').css('color','#c62828');
            }
        });
        resultsModel.on('error', function() {
            $('#preview-status').text('Error').css('color','#c62828');
            $('#preview-time').text(((new Date()-st)/1000).toFixed(1)+'s');
        });
        sm.on('search:done', function(props) {
            $('#preview-time').text(((new Date()-st)/1000).toFixed(1)+'s');
            // If no results data event fired, check if search returned 0 results
            if (props && props.content && props.content.resultCount === 0) {
                $('#preview-status').text('Complete').css('color','#2e7d32');
                $('#preview-count').text('0');
                $('#preview-results').html('<p>No results found.</p>');
            }
        });
        sm.on('search:error', function(msg) {
            $('#preview-status').text('Error').css('color','#c62828');
            $('#preview-time').text(((new Date()-st)/1000).toFixed(1)+'s');
            $('#preview-results').html('<p style="color:#c62828;">Search error: '+(msg||'Unknown')+'</p>');
        });
        sm.on('search:fail', function(msg) {
            $('#preview-status').text('Failed').css('color','#c62828');
            $('#preview-time').text(((new Date()-st)/1000).toFixed(1)+'s');
            $('#preview-results').html('<p style="color:#c62828;">Search failed: '+(msg||'Unknown')+'</p>');
        });
        sm.startSearch();
    }

    // ---- CREATE ALERT (with Approval Workflow) ----
    var _submitting = false;
    function createAlert() {
        if (_submitting) return;
        _submitting = true;

        var name = $.trim($('#fld_alert_name').val());
        var appName = $.trim($('#fld_app_name').val());
        var ticketCreation = $('#fld_ticket').val();
        var priority = $('#fld_priority').val() || 'P3';
        var eventClass = getEventClassValue();
        var assignmentGroup = $.trim($('#fld_assignment').val());
        var orgCode = $.trim($('#fld_orgcode').val());
        var cron = $('#fld_frequency').val();
        var t = getDur();
        var threshold = $('#fld_threshold').val() || '0';
        var trg = $('#fld_trigger').val() || 'once';
        var fullQuery = buildFullQuery();
        var baseQuery = $.trim($('#fld_query').val());
        var emailIds = $.trim($('#fld_email').val());
        var emailSubject = $.trim($('#fld_subject').val());
        var emailBody = $.trim($('#fld_body').val());

        if (cron === 'custom') {
            cron = $.trim($('#fld_custom_cron').val());
            if (!cron) { $('#form-errors').css({background:'#ffebee',color:'#c62828'}).html('Custom cron required').show(); _submitting = false; return; }
        }

        var isEdit = !!getUrlParam('alert');
        var verb = isEdit ? 'Updat' : 'Creat';

        console.log('[AF] ' + verb + 'ing alert: ' + name);
        $('#btn-submit').prop('disabled', true).css('opacity', '0.5').text(verb + 'ing...');
        $('#form-errors').css({background:'#e3f2fd',color:'#1565c0'}).html(verb + 'ing alert...').show();

        var params = {
            search: fullQuery,
            is_scheduled: '1',
            cron_schedule: cron,
            'dispatch.earliest_time': t.earliest,
            'dispatch.latest_time': t.latest,
            'alert.track': '0',
            alert_type: 'number of events',
            alert_comparator: 'greater than',
            alert_threshold: threshold,
            output_mode: 'json'
        };

        if (trg === 'for_each_result') {
            params['alert_type'] = 'always';
        }

        // Throttle
        var throttleEnabled = 'no';
        var suppressionPeriod = '';
        if ($('#fld_throttle').is(':checked')) {
            var sv = parseInt($('#fld_suppression').val()) || 0, su = $('#fld_suppression_unit').val();
            var sec = su === 'h' ? sv*3600 : su === 'm' ? sv*60 : sv;
            if (sec > 0) {
                params['alert.suppress'] = '1'; params['alert.suppress.period'] = sec + 's';
                throttleEnabled = 'yes'; suppressionPeriod = sec + 's';
            } else { params['alert.suppress'] = '0'; }
        } else { params['alert.suppress'] = '0'; }

        // DFSAlert action
        params['actions'] = 'DFSAlert';
        params['action.DFSAlert'] = '1';
        params['action.DFSAlert.param.app_name'] = appName;
        params['action.DFSAlert.param.ticket_creation'] = ticketCreation;
        params['action.DFSAlert.param.priority'] = priority;
        params['action.DFSAlert.param.email_ids'] = emailIds;
        if (ticketCreation === 'yes') {
            params['action.DFSAlert.param.event_class'] = eventClass;
            params['action.DFSAlert.param.assignment_group'] = assignmentGroup;
            params['action.DFSAlert.param.org_code'] = orgCode;
        }

        // For NEW alerts: create disabled at user level (approval workflow)
        // For EDIT: update existing alert directly
        if (isEdit && editRestPath) {
            // ---- EDIT MODE: direct update, no approval needed ----
            _rest('POST', editRestPath, params, function(err) {
                _submitting = false;
                $('#btn-submit').prop('disabled', false).css('opacity', '1').text('Update Alert');
                if (err) {
                    $('#form-errors').css({background:'#ffebee',color:'#c62828'}).html('Error: ' + (err.message || 'Unknown')).show();
                } else {
                    $('#form-errors').css({background:'#e8f5e9',color:'#2e7d32'}).html('&#10003; Alert updated: <strong>' + name + '</strong>').show();
                }
            });
        } else {
            // ---- CREATE MODE: save to CSV only, alert created on approval ----

            // Step 1: Check if alert already exists in Splunk OR in pending CSV
            _rest('GET', '/servicesNS/-/-/saved/searches/' + encodeURIComponent(name), { output_mode: 'json' }, function(chkErr) {
                if (!chkErr) {
                    _submitting = false;
                    $('#btn-submit').prop('disabled', false).css('opacity', '1').text('Submit');
                    $('#form-errors').css({background:'#ffebee',color:'#c62828'}).html('Error: Alert "<strong>' + name + '</strong>" already exists.').show();
                    return;
                }

                // Step 2: Write all alert config to CSV lookup for approval
                var alertData = {
                    alert_name: name,
                    app_name: appName,
                    priority: priority,
                    ticket_creation: ticketCreation,
                    event_class: ticketCreation === 'yes' ? eventClass : '',
                    assignment_group: ticketCreation === 'yes' ? assignmentGroup : '',
                    org_code: ticketCreation === 'yes' ? orgCode : '',
                    email_ids: emailIds,
                    email_subject: emailSubject,
                    email_body: emailBody,
                    query: fullQuery,
                    base_query: baseQuery,
                    cron_schedule: cron,
                    earliest_time: t.earliest,
                    latest_time: t.latest,
                    threshold: threshold,
                    trigger_type: trg,
                    throttle_enabled: throttleEnabled,
                    suppression_period: suppressionPeriod,
                    submitted_by: _currentUser,
                    submitted_time: new Date().toISOString(),
                    status: 'pending'
                };

                // Store full action params as JSON so approval can recreate exactly
                var actionParams = {};
                Object.keys(params).forEach(function(k) { actionParams[k] = params[k]; });

                // SPL-safe escape: handle \ and " for eval strings
                function splEsc(v) {
                    return (v || '').toString().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                }

                // Build eval string for CSV append
                var evalParts = [];
                var uniqueKey = Date.now() + '_' + Math.random().toString(36).substr(2, 6);
                evalParts.push('_key="' + uniqueKey + '"');
                evalParts.push('alert_name="' + splEsc(name) + '"');
                evalParts.push('app_name="' + splEsc(appName) + '"');
                evalParts.push('priority="' + splEsc(priority) + '"');
                evalParts.push('ticket_creation="' + splEsc(ticketCreation) + '"');
                evalParts.push('event_class="' + splEsc(ticketCreation === 'yes' ? eventClass : '') + '"');
                evalParts.push('assignment_group="' + splEsc(ticketCreation === 'yes' ? assignmentGroup : '') + '"');
                evalParts.push('org_code="' + splEsc(ticketCreation === 'yes' ? orgCode : '') + '"');
                evalParts.push('email_ids="' + splEsc(emailIds) + '"');
                evalParts.push('email_subject="' + splEsc(emailSubject) + '"');
                evalParts.push('email_body="' + splEsc(emailBody) + '"');
                evalParts.push('base_query="' + splEsc(baseQuery) + '"');
                evalParts.push('cron_schedule="' + splEsc(cron) + '"');
                evalParts.push('earliest_time="' + splEsc(t.earliest) + '"');
                evalParts.push('latest_time="' + splEsc(t.latest) + '"');
                evalParts.push('threshold="' + splEsc(threshold) + '"');
                evalParts.push('trigger_type="' + splEsc(trg) + '"');
                evalParts.push('throttle_enabled="' + splEsc(throttleEnabled) + '"');
                evalParts.push('suppression_period="' + splEsc(suppressionPeriod) + '"');
                evalParts.push('submitted_by="' + splEsc(_currentUser) + '"');
                evalParts.push('submitted_time="' + new Date().toISOString() + '"');
                evalParts.push('status="pending"');
                evalParts.push('reviewed_by=""');
                evalParts.push('reviewed_time=""');
                evalParts.push('action_params="' + splEsc(JSON.stringify(actionParams)) + '"');

                // Store query separately as base64 to avoid pipe/quote issues in SPL
                var queryB64 = btoa(unescape(encodeURIComponent(fullQuery)));
                evalParts.push('query="' + queryB64 + '"');
                evalParts.push('query_encoded="1"');

                var appendSearch = '| makeresults | eval ' + evalParts.join(', ') + ' | fields - _time | outputlookup append=t pending_alerts_lookup';

                console.log('[AF] Writing alert config to CSV lookup');
                // Use REST directly instead of SearchManager to avoid $token$ substitution
                _rest('POST', '/servicesNS/' + encodeURIComponent(_currentUser) + '/alerting_framework/search/jobs', {
                    search: appendSearch,
                    exec_mode: 'oneshot',
                    output_mode: 'json'
                }, function(csvErr) {
                    if (csvErr) console.warn('[AF] CSV write failed: ' + csvErr.message);
                    else console.log('[AF] ✓ CSV lookup entry created');
                });

                // Step 3: Send approval email
                sendApprovalEmail(name, appName, priority, ticketCreation, eventClass, assignmentGroup, orgCode, emailIds, baseQuery, cron, threshold, trg);

                // Show success
                _submitting = false;
                $('#btn-submit').prop('disabled', false).css('opacity', '1').text('Submit');
                $('#form-errors').css({background:'#e8f5e9',color:'#2e7d32'}).html(
                    '&#10003; Alert "<strong>' + name + '</strong>" submitted for approval. ' +
                    'Approval email sent to configured recipients. ' +
                    'Alert will be created once approved.'
                ).show();
            });
        }
    }

    // ---- Send approval email via Splunk sendemail ----
    function sendApprovalEmail(name, appName, priority, ticket, eventClass, assignmentGroup, orgCode, emailIds, query, cron, threshold, trigger) {
        // Read approval settings from CSV lookup
        var sm = new SearchManager({
            id: 'read_settings_' + Date.now(),
            search: '| inputlookup alert_settings_lookup | head 1',
            earliest_time: '-1m',
            latest_time: 'now',
            autostart: true
        });
        sm.on('search:done', function() {
            var results = sm.data('results');
            if (!results) { console.warn('[AF] No settings results'); return; }
            results.on('data', function() {
                var rows = results.data().rows;
                var fields = results.data().fields;
                var approvalEmails = '', dashboardUrl = '';
                if (rows && rows.length > 0) {
                    var idx = function(f) { return fields.indexOf(f); };
                    approvalEmails = rows[0][idx('approval_emails')] || '';
                    dashboardUrl = rows[0][idx('approval_dashboard_url')] || '';
                }

                if (!approvalEmails) {
                    console.warn('[AF] No approval emails configured in lookup. Skipping email.');
                    return;
                }

                if (!dashboardUrl) {
                    dashboardUrl = window.location.origin + Splunk.util.make_url('/app/alerting_framework/alert_approval');
                }

                var ticketStr = (ticket === 'yes') ? 'Yes' : 'No';
                var ticketDetails = '';
                if (ticket === 'yes') {
                    ticketDetails =
                        '<tr><td style=\\"padding:8px 12px;font-weight:600;color:#555;\\">Event Class</td><td style=\\"padding:8px 12px;\\">' + eventClass + '</td></tr>' +
                        '<tr><td style=\\"padding:8px 12px;font-weight:600;color:#555;\\">Assignment Group</td><td style=\\"padding:8px 12px;\\">' + assignmentGroup + '</td></tr>' +
                        '<tr><td style=\\"padding:8px 12px;font-weight:600;color:#555;\\">Org Code</td><td style=\\"padding:8px 12px;\\">' + orgCode + '</td></tr>';
                }

                var htmlBody =
                    '<html><body style=\\"font-family:Arial,sans-serif;margin:0;padding:20px;background:#f4f5f8;\\">' +
                    '<div style=\\"max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);\\">' +
                    '<div style=\\"background:linear-gradient(135deg,#1565c0,#1e88e5);color:#fff;padding:20px 24px;\\">' +
                    '<h2 style=\\"margin:0;font-size:18px;\\">Alert Approval Required</h2>' +
                    '<p style=\\"margin:5px 0 0;color:#bbdefb;font-size:13px;\\">A new alert has been submitted and requires your approval.</p>' +
                    '</div>' +
                    '<div style=\\"padding:20px 24px;\\">' +
                    '<table style=\\"width:100%;border-collapse:collapse;\\">' +
                    '<tr style=\\"background:#f9fafb;\\"><td style=\\"padding:8px 12px;font-weight:600;color:#555;\\">Alert Name</td><td style=\\"padding:8px 12px;font-weight:700;\\">' + name + '</td></tr>' +
                    '<tr><td style=\\"padding:8px 12px;font-weight:600;color:#555;\\">Application</td><td style=\\"padding:8px 12px;\\">' + appName + '</td></tr>' +
                    '<tr style=\\"background:#f9fafb;\\"><td style=\\"padding:8px 12px;font-weight:600;color:#555;\\">Priority</td><td style=\\"padding:8px 12px;\\">' + priority + '</td></tr>' +
                    '<tr><td style=\\"padding:8px 12px;font-weight:600;color:#555;\\">Email To</td><td style=\\"padding:8px 12px;\\">' + emailIds + '</td></tr>' +
                    '<tr style=\\"background:#f9fafb;\\"><td style=\\"padding:8px 12px;font-weight:600;color:#555;\\">Ticket Creation</td><td style=\\"padding:8px 12px;\\">' + ticketStr + '</td></tr>' +
                    ticketDetails +
                    '<tr><td style=\\"padding:8px 12px;font-weight:600;color:#555;\\">Schedule</td><td style=\\"padding:8px 12px;\\">' + cron + '</td></tr>' +
                    '<tr style=\\"background:#f9fafb;\\"><td style=\\"padding:8px 12px;font-weight:600;color:#555;\\">Threshold</td><td style=\\"padding:8px 12px;\\">' + threshold + '</td></tr>' +
                    '<tr><td style=\\"padding:8px 12px;font-weight:600;color:#555;\\">Trigger</td><td style=\\"padding:8px 12px;\\">' + trigger + '</td></tr>' +
                    '<tr style=\\"background:#f9fafb;\\"><td style=\\"padding:8px 12px;font-weight:600;color:#555;\\">Submitted By</td><td style=\\"padding:8px 12px;\\">' + _currentUser + '</td></tr>' +
                    '</table>' +
                    '<div style=\\"margin-top:16px;padding:12px;background:#1a1c20;border-radius:4px;\\">' +
                    '<div style=\\"font-size:11px;color:#888;margin-bottom:4px;\\">SEARCH QUERY</div>' +
                    '<div style=\\"color:#a3e635;font-family:monospace;font-size:12px;word-break:break-all;\\">' + query + '</div>' +
                    '</div>' +
                    '<div style=\\"margin-top:20px;text-align:center;\\">' +
                    '<a href=\\"' + dashboardUrl + '\\" style=\\"display:inline-block;background:linear-gradient(135deg,#1565c0,#1e88e5);color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;\\">Review &amp; Approve</a>' +
                    '</div>' +
                    '</div></div></body></html>';

                var safeSubject = 'Alert Approval Required: ' + name.replace(/"/g, '\\"');
                var safeBody = htmlBody.replace(/'/g, "\\'");
                var searchCmd = '| makeresults | sendemail to="' + approvalEmails + '" subject="' + safeSubject + '" message="' + safeBody + '" content_type=html sendresults=false';

                console.log('[AF] Sending approval email to: ' + approvalEmails);
                _rest('POST', '/services/search/jobs', {
                    search: searchCmd,
                    exec_mode: 'oneshot',
                    output_mode: 'json'
                }, function(emailErr) {
                    if (emailErr) console.warn('[AF] Approval email failed: ' + emailErr.message);
                    else console.log('[AF] ✓ Approval email sent');
                });
            });
        });
        sm.on('search:error', function() {
            console.warn('[AF] Could not read settings lookup. Approval email not sent.');
        });
    }

    // ---- CLEAR ----
    function clearForm() {
        $('#fld_alert_name,#fld_query,#fld_email,#fld_subject,#fld_body').val('');
        $('#fld_app_name,#fld_eventclass,#fld_assignment,#fld_orgcode').val('');
        $('#fld_eventclass_custom').val('').hide();
        $('#fld_ticket').val('no');$('#fld_priority').val('P3');
        setDuration('-15m','now','Last 15 minutes');
        $('#fld_frequency').val('*/15 * * * *');$('#fld_custom_cron').val('').hide();
        $('#fld_threshold').val('0');$('#fld_trigger').val('once');
        $('.trigger-btn').css({background:'#f5f5f5',color:'#333'}).removeClass('active');
        $('.trigger-btn[data-value="once"]').css({background:'#1976d2',color:'white'}).addClass('active');
        $('#fld_throttle').prop('checked',false);$('#throttle-options').hide();
        hideAllErrors();toggleTicketFields();isAcknowledged=false;
        $('#btn-ack').removeClass('btn-success').addClass('btn-warning').text('Acknowledge Configuration').prop('disabled',true);
        $('#ack-status').text('');$('#form-errors').hide().text('');
        $('#preview-query').text('-');$('#preview-status').text('Pending');
        $('#preview-time').text('-');$('#preview-count').text('-');$('#preview-results').html('Click Preview to run');
        // Hide preview and summary sections
        $('#preview_row').slideUp(200);$('#summary_row').slideUp(200);
        updateSummary();
    }

    // ---- EVENTS ----
    $(document).on('change','#fld_ticket',function(){toggleTicketFields();resetAcknowledge();});
    $(document).on('change','#fld_throttle',function(){$(this).is(':checked')?$('#throttle-options').show():$('#throttle-options').hide();resetAcknowledge();updateSummary();});
    $(document).on('change','#fld_frequency',function(){$(this).val()==='custom'?$('#fld_custom_cron').show().focus():$('#fld_custom_cron').hide().val('');resetAcknowledge();updateSummary();});
    $(document).on('input','#fld_custom_cron',updateSummary);
    // Reset acknowledgment when any form field changes (forces re-review before submit)
    function resetAcknowledge() {
        if (isAcknowledged) {
            isAcknowledged = false;
            $('#btn-ack').removeClass('btn-success').addClass('btn-warning').text('Acknowledge Configuration');
            $('#ack-status').text('');
        }
    }
    $(document).on('input change','#fld_alert_name,#fld_app_name,#fld_query,#fld_email,#fld_subject,#fld_priority,#fld_threshold,#fld_suppression,#fld_suppression_unit,#fld_ticket,#fld_frequency,#fld_custom_cron,#fld_eventclass,#fld_eventclass_custom,#fld_assignment,#fld_orgcode,#fld_body',function(){ resetAcknowledge(); updateSummary(); });
    $(document).on('click','.trigger-btn',function(){var v=$(this).data('value');$('#fld_trigger').val(v);$('.trigger-btn').css({background:'#f5f5f5',color:'#333'}).removeClass('active');$(this).css({background:'#1976d2',color:'white'}).addClass('active');resetAcknowledge();updateSummary();});
    $(document).on('click','#btn-refresh-macros',loadMacros);
    $(document).on('click','.btn-insert-macro',function(){$('#fld_query').val($('#fld_query').val()+'`'+$(this).data('name')+'`');updateSummary();});
    $(document).on('click','.btn-use-example',function(){$('#fld_query').val($(this).data('query'));updateSummary();});
    $(document).on('click','#btn-refresh-templates',loadTemplates);
    $(document).on('click','.btn-apply-template',function(){
        var i=parseInt($(this).data('idx'));if(i<0||i>=templatesList.length)return;var t=templatesList[i];
        $('#fld_alert_name').val(t.name+' - ');$('#fld_ticket').val(t.ticket||'no');
        if(t.ticket==='yes'){
            // Set event class - check if value exists in dropdown, otherwise use "New Event Class"
            var ecExists = $('#fld_eventclass option[value="'+t.event_class+'"]').length > 0;
            if(ecExists) { $('#fld_eventclass').val(t.event_class); $('#fld_eventclass_custom').hide().val(''); }
            else if(t.event_class) { $('#fld_eventclass').val('__new__'); $('#fld_eventclass_custom').show().val(t.event_class); }
            // Set assignment group and org code
            var agExists = $('#fld_assignment option[value="'+t.assignment_group+'"]').length > 0;
            if(agExists) $('#fld_assignment').val(t.assignment_group); else if(t.assignment_group) $('#fld_assignment').val(t.assignment_group);
            var ocExists = $('#fld_orgcode option[value="'+t.org_code+'"]').length > 0;
            if(ocExists) $('#fld_orgcode').val(t.org_code); else if(t.org_code) $('#fld_orgcode').val(t.org_code);
        }
        // Set app name
        var appExists = $('#fld_app_name option[value="'+t.app_name+'"]').length > 0;
        if(appExists) $('#fld_app_name').val(t.app_name);
        if(t.query)$('#fld_query').val(t.query);if(t.email)$('#fld_email').val(t.email);
        $('#fld_subject').val((t.subject_prefix||'[ALERT]')+' $name$');if(t.email_body)$('#fld_body').val(t.email_body);$('#fld_priority').val(t.priority||'P3');
        if(t.duration) setDuration(t.duration, 'now', 'Last ' + t.duration.replace('-',''));
        $('#fld_frequency').val(t.frequency||'*/15 * * * *');if(t.frequency!=='custom')$('#fld_custom_cron').hide().val('');$('#fld_threshold').val(t.threshold||'0');
        var sv=parseInt(t.suppression)||0;if(sv>0){$('#fld_throttle').prop('checked',true);$('#throttle-options').show();$('#fld_suppression').val(sv);}else{$('#fld_throttle').prop('checked',false);$('#throttle-options').hide();}
        toggleTicketFields();updateSummary();$('html,body').animate({scrollTop:$('#fld_alert_name').offset().top-100},300);$('#fld_alert_name').focus().select();
    });
    $(document).on('click','#btn-expand-macros',function(){var q=$('#fld_query').val(),c=0;if(!q)return;macrosList.forEach(function(m){var p='`'+m.name+'`';if(q.indexOf(p)!==-1){q=q.split(p).join(m.def);c++;}});if(c){$('#fld_query').val(q);$('#preview-query').text('Expanded '+c+' macro(s)');}});
    $(document).on('click','#btn-validate-query',function(){var q=$.trim($('#fld_query').val());if(!q){$('#query-status').text('No query').css('color','#c62828');return;}$('#query-status').text('Validating...').css('color','#1976d2');var sm=new SearchManager({id:'val_'+Date.now(),search:q+' | head 1',earliest_time:'-1m',latest_time:'now'});sm.on('search:done',function(){$('#query-status').text('Valid').css('color','#2e7d32');});sm.on('search:error',function(){$('#query-status').text('Invalid').css('color','#c62828');});sm.startSearch();});
    $(document).on('click','#btn-preview',function(){if(!validateAll())return;$('#preview_row').slideDown(300);$('#summary_row').slideDown(300);updateSummary();runPreview();});
    $(document).off('click','#btn-submit').on('click','#btn-submit',function(e){e.preventDefault();if(!validateAll())return;if(!isAcknowledged){$('#form-errors').css({background:'#ffebee',color:'#c62828'}).html('Please review the Summary below and click Acknowledge before submitting.').show();$('html,body').animate({scrollTop:$('#btn-ack').offset().top-100},300);return;}createAlert();});
    $(document).on('click','#btn-clear',clearForm);
    $(document).on('click','#btn-ack',function(){isAcknowledged=true;$(this).removeClass('btn-warning').addClass('btn-success').text('Acknowledged');$('#ack-status').text('Ready to submit for approval').css('color','#2e7d32');});
    $(document).on('click','#quick-start-header',function(){var $r=$('#quick_start_content').closest('.dashboard-row'),$i=$('#qs-icon');$r.is(':visible')?($r.slideUp(300),$i.text('\u25B6')):($r.slideDown(300),$i.text('\u25BC'));});

    // ---- INIT ----
    console.log('[AF] Init...');
    setTimeout(function(){$('#quick_start_content').closest('.dashboard-row').hide();$('#qs-icon').text('\u25B6');},100);
    setTimeout(function(){$('.fieldset,.dashboard-form-globalfieldset').hide();},100);
    // Hide Preview Results and Summary until user clicks Preview
    setTimeout(function(){$('#preview_row').hide();$('#summary_row').hide();},200);
    loadMacros();loadTemplates();loadAllLookups();toggleTicketFields();updateSummary();

    // ---- EDIT MODE: Load alert from ?alert=<name> URL parameter ----
    function loadAlertForEdit(alertName) {
        console.log('[AF] EDIT MODE: Loading alert "' + alertName + '"');
        $('#form-errors').css({background:'#e3f2fd',color:'#1565c0'}).html('Loading alert: <strong>' + alertName + '</strong>...').show();

        _rest('GET', '/servicesNS/-/-/saved/searches/' + encodeURIComponent(alertName), { output_mode:'json' }, function(err, resp) {
            if (err) {
                console.error('[AF] Load alert failed:', err.message);
                $('#form-errors').css({background:'#ffebee',color:'#c62828'}).html('Error loading alert: ' + err.message).show();
                return;
            }
            try {
                var data = (typeof resp === 'string') ? JSON.parse(resp) : resp;
                var entry = data.entry ? data.entry[0] : data;
                var c = entry.content || {};
                var search = c.search || '';

                console.log('[AF] Alert loaded. Search: ' + search.substring(0, 100));

                // Store exact REST path from entry.id for update endpoint
                editRestPath = '';
                if (entry.id) {
                    var idMatch = entry.id.match(/(\/servicesNS\/[^?]+)/);
                    if (idMatch) editRestPath = idMatch[1];
                }
                if (!editRestPath && entry.links && entry.links.edit) {
                    var linkMatch = entry.links.edit.match(/(\/servicesNS\/[^?]+)/);
                    if (linkMatch) editRestPath = linkMatch[1];
                }
                if (!editRestPath) {
                    // Fallback: construct from acl
                    var own = (entry.acl && entry.acl.sharing !== 'user') ? 'nobody' : (entry.acl ? entry.acl.owner : 'nobody');
                    var ap = entry.acl ? entry.acl.app : 'alerting_framework';
                    editRestPath = '/servicesNS/' + encodeURIComponent(own) + '/' + encodeURIComponent(ap) + '/saved/searches/' + encodeURIComponent(alertName);
                }
                console.log('[AF] Edit restPath: ' + editRestPath);

                // Set alert name
                $('#fld_alert_name').val(alertName);

                // Parse eval fields from search query
                // Format: <base_query> | eval field1="val1", field2="val2"
                var baseQuery = search;
                var evalFields = {};
                var evalMatch = search.match(/^([\s\S]*?)\s*\|\s*eval\s+([\s\S]+)$/);
                if (evalMatch) {
                    baseQuery = $.trim(evalMatch[1]);
                    var evalStr = evalMatch[2];
                    // Parse key="value" pairs from eval string
                    var re = /(\w+)\s*=\s*"([^"]*)"/g, m;
                    while ((m = re.exec(evalStr)) !== null) {
                        evalFields[m[1]] = m[2];
                    }
                    console.log('[AF] Parsed eval fields:', JSON.stringify(evalFields));
                }

                // Fill form fields from action params (stored as action.DFSAlert.param.*)
                $('#fld_query').val(baseQuery);

                // Read action params from saved search content
                var ap = function(k) { return c['action.DFSAlert.param.' + k] || ''; };

                // Set dropdown values - use timeout to ensure lookups are loaded
                setTimeout(function() {
                    var appVal = ap('app_name');
                    if (appVal) {
                        var appOpt = $('#fld_app_name option[value="'+appVal+'"]');
                        if (appOpt.length) $('#fld_app_name').val(appVal);
                        else {
                            $('#fld_app_name').append('<option value="'+appVal+'">'+appVal+'</option>');
                            $('#fld_app_name').val(appVal);
                        }
                    }
                    var ecVal = ap('event_class');
                    if (ecVal) {
                        var ecOpt = $('#fld_eventclass option[value="'+ecVal+'"]');
                        if (ecOpt.length) { $('#fld_eventclass').val(ecVal); $('#fld_eventclass_custom').hide().val(''); }
                        else { $('#fld_eventclass').val('__new__'); $('#fld_eventclass_custom').show().val(ecVal); }
                    }
                    var agVal = ap('assignment_group');
                    if (agVal) {
                        var agOpt = $('#fld_assignment option[value="'+agVal+'"]');
                        if (agOpt.length) $('#fld_assignment').val(agVal);
                        else {
                            $('#fld_assignment').append('<option value="'+agVal+'">'+agVal+'</option>');
                            $('#fld_assignment').val(agVal);
                        }
                    }
                    var ocVal = ap('org_code');
                    if (ocVal) {
                        var ocOpt = $('#fld_orgcode option[value="'+ocVal+'"]');
                        if (ocOpt.length) $('#fld_orgcode').val(ocVal);
                        else {
                            $('#fld_orgcode').append('<option value="'+ocVal+'">'+ocVal+'</option>');
                            $('#fld_orgcode').val(ocVal);
                        }
                    }
                    toggleTicketFields();
                    updateSummary();
                }, 1500);

                // Ticket & priority from action params
                var tkVal = ap('ticket_creation');
                if (tkVal === '1' || tkVal === 'yes') $('#fld_ticket').val('yes');
                else if (tkVal) $('#fld_ticket').val(tkVal);
                if (ap('priority')) $('#fld_priority').val(ap('priority'));
                if (ap('email_ids')) $('#fld_email').val(ap('email_ids'));

                // email_subject and email_body from eval fields in query
                if (evalFields.email_subject) $('#fld_subject').val(evalFields.email_subject);
                if (evalFields.email_body) $('#fld_body').val(evalFields.email_body);

                // Schedule fields
                if (c.cron_schedule) {
                    var cronVal = c.cron_schedule;
                    var found = false;
                    $('#fld_frequency option').each(function() {
                        if ($(this).val() === cronVal) { found = true; }
                    });
                    if (found) {
                        $('#fld_frequency').val(cronVal);
                        $('#fld_custom_cron').hide().val('');
                    } else {
                        $('#fld_frequency').val('custom');
                        $('#fld_custom_cron').val(cronVal).show();
                    }
                }

                // Duration from dispatch times
                var earliest = c['dispatch.earliest_time'] || '-15m';
                var latest = c['dispatch.latest_time'] || 'now';
                // Find matching preset label
                var durLabel = earliest + ' to ' + latest;
                $('.tp-opt').each(function() {
                    if (String($(this).data('e')) === earliest && String($(this).data('l')) === latest) {
                        durLabel = $(this).text().trim();
                    }
                });
                setDuration(earliest, latest, durLabel);

                // Threshold
                if (c.alert_threshold) $('#fld_threshold').val(c.alert_threshold);

                // Trigger type
                var trigVal = 'once';
                if (c.alert_type === 'always') trigVal = 'for_each_result';
                $('#fld_trigger').val(trigVal);
                $('.trigger-btn').css({background:'#f5f5f5',color:'#333'}).removeClass('active');
                $('.trigger-btn[data-value="'+trigVal+'"]').css({background:'#1976d2',color:'white'}).addClass('active');

                // Throttle
                if (c['alert.suppress'] === '1' || c['alert.suppress'] === true) {
                    $('#fld_throttle').prop('checked', true);
                    $('#throttle-options').show();
                    var period = c['alert.suppress.period'] || '';
                    // Parse period like "300s" or "5m"
                    var pMatch = period.match(/^(\d+)(s|m|h)?$/);
                    if (pMatch) {
                        var pVal = parseInt(pMatch[1]), pUnit = pMatch[2] || 's';
                        if (pUnit === 's' && pVal >= 60 && pVal % 60 === 0) { pVal = pVal / 60; pUnit = 'm'; }
                        if (pUnit === 'm' && pVal >= 60 && pVal % 60 === 0) { pVal = pVal / 60; pUnit = 'h'; }
                        $('#fld_suppression').val(pVal);
                        $('#fld_suppression_unit').val(pUnit);
                    }
                } else {
                    $('#fld_throttle').prop('checked', false);
                    $('#throttle-options').hide();
                }

                // Toggle ticket fields
                toggleTicketFields();
                updateSummary();

                // Change Submit to "Update Alert" mode
                $('#btn-submit').text('Update Alert');
                $('#form-errors').css({background:'#e8f5e9',color:'#2e7d32'}).html('&#10003; Loaded alert: <strong>' + alertName + '</strong> — Review and update.').show();
                // Scroll to top
                $('html,body').animate({scrollTop: 0}, 300);

            } catch(parseErr) {
                console.error('[AF] Parse error:', parseErr);
                $('#form-errors').css({background:'#ffebee',color:'#c62828'}).html('Error parsing alert data: ' + parseErr.message).show();
            }
        });
    }

    // Check for ?alert= parameter on page load
    var editAlertName = getUrlParam('alert');
    if (editAlertName) {
        // Wait for DOM to be ready then load
        setTimeout(function() { loadAlertForEdit(editAlertName); }, 500);
    }
});
