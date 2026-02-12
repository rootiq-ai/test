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
            ajaxOpts.data = $.param(params || {});
            ajaxOpts.contentType = 'application/x-www-form-urlencoded; charset=UTF-8';
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
        parts.push('alert_name="' + $.trim($('#fld_alert_name').val()).replace(/"/g,'\\"') + '"');
        parts.push('app_name="' + $.trim($('#fld_app_name').val()).replace(/"/g,'\\"') + '"');
        parts.push('ticket_creation="' + $('#fld_ticket').val() + '"');
        parts.push('priority="' + ($('#fld_priority').val()||'P3') + '"');
        if ($('#fld_ticket').val()==='yes') {
            parts.push('event_class="' + $.trim($('#fld_eventclass').val()).replace(/"/g,'\\"') + '"');
            parts.push('assignment_group="' + $.trim($('#fld_assignment').val()).replace(/"/g,'\\"') + '"');
            parts.push('org_code="' + $.trim($('#fld_orgcode').val()).replace(/"/g,'\\"') + '"');
        }
        parts.push('email_ids="' + $.trim($('#fld_email').val()).replace(/"/g,'\\"') + '"');
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
        if (tk && !$.trim($('#fld_eventclass').val())) { showErr('eventclass','Required'); errs.push('Event Class'); }
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
    function updateSummary() {
        $('#sum-name').text($('#fld_alert_name').val()||'-');
        $('#sum-app').text($('#fld_app_name').val()||'-');
        $('#sum-ticket').text($('#fld_ticket').val()==='yes'?'Yes':'No');
        $('#sum-email').text($('#fld_email').val()||'-');
        $('#sum-priority').text($('#fld_priority').val()||'-');
        $('#sum-duration').text(getDurLabel());
        var fv=$('#fld_frequency').val(), ft=$('#fld_frequency option:selected').text();
        if(fv==='custom'){var c=$.trim($('#fld_custom_cron').val()); ft=c?'Custom: '+c:'Custom';}
        $('#sum-frequency').text(ft);
        $('#sum-threshold').text($('#fld_threshold').val()||'0');
        $('#sum-trigger').text($('#fld_trigger').val()==='for_each_result'?'For each result':'Once');
        var st='None'; if($('#fld_throttle').is(':checked')){ var sv=parseInt($('#fld_suppression').val())||0, su=$('#fld_suppression_unit').val(); st=sv+' '+(su==='s'?'sec':su==='m'?'min':'hr')+'(s)'; }
        $('#sum-suppression').text(st);
        $('#sum-query').text($.trim($('#fld_query').val())?buildFullQuery():'-');
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

    // ---- CREATE ALERT ----
    var _submitting = false;
    var _submitCount = 0;
    function createAlert() {
        _submitCount++;
        var thisCall = _submitCount;
        console.log('[AF] *** createAlert() called #' + thisCall + ' ***');
        console.trace('[AF] Call stack for createAlert #' + thisCall);

        if (_submitting) { console.log('[AF] #' + thisCall + ' BLOCKED: submit already in progress'); return; }
        _submitting = true;

        var name=$.trim($('#fld_alert_name').val()), appN=$.trim($('#fld_app_name').val()), tk=$('#fld_ticket').val(), pri=$('#fld_priority').val()||'P3', trg=$('#fld_trigger').val()||'once';
        var cron=$('#fld_frequency').val(), t=getDur(), thr=$('#fld_threshold').val()||'0', fq=buildFullQuery();
        if(cron==='custom'){cron=$.trim($('#fld_custom_cron').val());if(!cron){$('#form-errors').css({background:'#ffebee',color:'#c62828'}).html('Custom cron required').show();_submitting=false;return;}}
        var p={search:fq,is_scheduled:'1',disabled:'0',cron_schedule:cron,'dispatch.earliest_time':t.earliest,'dispatch.latest_time':t.latest,'alert.track':'1'};
        if(trg==='for_each_result'){p['alert_type']='always';}else{p['alert_type']='number of events';p['alert_comparator']='greater than';p['alert_threshold']=thr;}
        if($('#fld_throttle').is(':checked')){var sv=parseInt($('#fld_suppression').val())||0,su=$('#fld_suppression_unit').val();var sec=su==='h'?sv*3600:su==='m'?sv*60:sv;p['alert.suppress']=sec>0?'1':'0';if(sec>0)p['alert.suppress.period']=sec+'s';}else{p['alert.suppress']='0';}
        p['actions']='DFSAlert, logevent';p['action.DFSAlert']='1';p['action.DFSAlert.param.alert_name']=name;p['action.DFSAlert.param.app_name']=appN;p['action.DFSAlert.param.ticket_creation']=tk;p['action.DFSAlert.param.priority']=pri;
        if(tk==='yes'){p['action.DFSAlert.param.event_class']=$.trim($('#fld_eventclass').val());p['action.DFSAlert.param.assignment_group']=$.trim($('#fld_assignment').val());p['action.DFSAlert.param.org_code']=$.trim($('#fld_orgcode').val());}
        p['action.logevent']='1';p['action.logevent.param.index']='main';p['action.logevent.param.source']='alerting_framework';p['action.logevent.param.sourcetype']='alert:dfs';p['action.logevent.param.event']='Alert triggered: ' + name + ' | app=' + appN + ' | priority=' + pri;

        // Determine if this is an update (edit mode) or new create
        var isEdit = !!getUrlParam('alert');
        var endpoint, verb;
        if (isEdit && editRestPath) {
            // UPDATE: use the exact REST path from Splunk's entry.id
            endpoint = editRestPath;
            verb = 'Updat';
        } else {
            // CREATE: use current logged-in user to avoid ghost duplicates
            endpoint = '/servicesNS/' + encodeURIComponent(_currentUser) + '/alerting_framework/saved/searches';
            p.name = name;
            verb = 'Creat';
        }

        console.log('[AF] #' + thisCall + ' ' + verb + 'ing alert: ' + name + ' endpoint: ' + endpoint);
        $('#btn-submit').prop('disabled', true).css('opacity', '0.5').text(verb + 'ing...');
        $('#form-errors').css({background:'#e3f2fd',color:'#1565c0'}).html(verb + 'ing alert...').show();

        function doSubmit() {
            console.log('[AF] #' + thisCall + ' >>> SENDING POST to: ' + endpoint);
            _rest('POST', endpoint, p, function(err) {
                _submitting = false;
                $('#btn-submit').prop('disabled', false).css('opacity', '1').text(isEdit ? 'Update Alert' : 'Submit');
                if (err) {
                    var m = err.message;
                    if (err.status === 409) m = 'Alert "' + name + '" already exists. Use Edit to update it.';
                    console.error('[AF] #' + thisCall + ' FAILED: ' + m);
                    $('#form-errors').css({background:'#ffebee',color:'#c62828'}).html('Error: ' + m).show();
                } else {
                    console.log('[AF] #' + thisCall + ' SUCCESS');
                    $('#form-errors').css({background:'#e8f5e9',color:'#2e7d32'}).html('&#10003; Alert ' + verb + 'ed: <strong>' + name + '</strong>').show();
                }
            });
        }

        if (!isEdit) {
            // CHECK if alert already exists before creating
            console.log('[AF] #' + thisCall + ' Checking if "' + name + '" exists...');
            _rest('GET', '/servicesNS/-/-/saved/searches/' + encodeURIComponent(name), { output_mode: 'json' }, function(err) {
                if (!err) {
                    // Alert exists — don't create duplicate
                    console.warn('[AF] #' + thisCall + ' Alert "' + name + '" already exists! Aborting create.');
                    _submitting = false;
                    $('#btn-submit').prop('disabled', false).css('opacity', '1').text('Submit');
                    $('#form-errors').css({background:'#ffebee',color:'#c62828'}).html('Alert "<strong>' + name + '</strong>" already exists. Go to Alert Management to edit it.').show();
                    return;
                }
                // Alert doesn't exist — safe to create
                console.log('[AF] #' + thisCall + ' Alert does not exist, creating...');
                doSubmit();
            });
        } else {
            doSubmit();
        }
    }

    // ---- CLEAR ----
    function clearForm() {
        $('#fld_alert_name,#fld_app_name,#fld_eventclass,#fld_assignment,#fld_orgcode,#fld_query,#fld_email,#fld_subject,#fld_body').val('');
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
    $(document).on('input change','#fld_alert_name,#fld_app_name,#fld_query,#fld_email,#fld_subject,#fld_priority,#fld_threshold,#fld_suppression,#fld_suppression_unit,#fld_ticket,#fld_frequency,#fld_custom_cron,#fld_eventclass,#fld_assignment,#fld_orgcode,#fld_body',function(){ resetAcknowledge(); updateSummary(); });
    $(document).on('click','.trigger-btn',function(){var v=$(this).data('value');$('#fld_trigger').val(v);$('.trigger-btn').css({background:'#f5f5f5',color:'#333'}).removeClass('active');$(this).css({background:'#1976d2',color:'white'}).addClass('active');resetAcknowledge();updateSummary();});
    $(document).on('click','#btn-refresh-macros',loadMacros);
    $(document).on('click','.btn-insert-macro',function(){$('#fld_query').val($('#fld_query').val()+'`'+$(this).data('name')+'`');updateSummary();});
    $(document).on('click','.btn-use-example',function(){$('#fld_query').val($(this).data('query'));updateSummary();});
    $(document).on('click','#btn-refresh-templates',loadTemplates);
    $(document).on('click','.btn-apply-template',function(){
        var i=parseInt($(this).data('idx'));if(i<0||i>=templatesList.length)return;var t=templatesList[i];
        $('#fld_alert_name').val(t.name+' - ');$('#fld_ticket').val(t.ticket||'no');
        if(t.ticket==='yes'){$('#fld_eventclass').val(t.event_class);$('#fld_assignment').val(t.assignment_group);$('#fld_orgcode').val(t.org_code);}
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
    $(document).on('click','#btn-ack',function(){isAcknowledged=true;$(this).removeClass('btn-warning').addClass('btn-success').text('Acknowledged');$('#ack-status').text('Ready to submit').css('color','#2e7d32');});
    $(document).on('click','#quick-start-header',function(){var $r=$('#quick_start_content').closest('.dashboard-row'),$i=$('#qs-icon');$r.is(':visible')?($r.slideUp(300),$i.text('\u25B6')):($r.slideDown(300),$i.text('\u25BC'));});

    // ---- INIT ----
    console.log('[AF] Init...');
    setTimeout(function(){$('#quick_start_content').closest('.dashboard-row').hide();$('#qs-icon').text('\u25B6');},100);
    setTimeout(function(){$('.fieldset,.dashboard-form-globalfieldset').hide();},100);
    // Hide Preview Results and Summary until user clicks Preview
    setTimeout(function(){$('#preview_row').hide();$('#summary_row').hide();},200);
    loadMacros();loadTemplates();toggleTicketFields();updateSummary();

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

                // Fill form fields from eval or content
                $('#fld_query').val(baseQuery);
                if (evalFields.app_name) $('#fld_app_name').val(evalFields.app_name);
                if (evalFields.ticket_creation) $('#fld_ticket').val(evalFields.ticket_creation);
                if (evalFields.priority) $('#fld_priority').val(evalFields.priority);
                if (evalFields.event_class) $('#fld_eventclass').val(evalFields.event_class);
                if (evalFields.assignment_group) $('#fld_assignment').val(evalFields.assignment_group);
                if (evalFields.org_code) $('#fld_orgcode').val(evalFields.org_code);
                if (evalFields.email_ids) $('#fld_email').val(evalFields.email_ids);
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
