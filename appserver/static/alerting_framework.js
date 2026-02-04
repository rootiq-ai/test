require([
    'jquery',
    'underscore',
    'splunkjs/mvc',
    'splunkjs/mvc/simplexml/ready!',
    'splunkjs/mvc/searchmanager'
], function($, _, mvc, ready, SearchManager) {
    
    // State
    var isAcknowledged = false;
    var macrosList = [];
    var templatesList = [];
    
    // Get token models for time picker
    var defaultTokens = mvc.Components.get('default');
    var submittedTokens = mvc.Components.get('submitted');
    
    // Move time picker from fieldset to form row
    function moveTimePicker() {
        var attempts = 0;
        var maxAttempts = 20;
        
        function tryMove() {
            attempts++;
            
            // Find the time picker in fieldset
            var $fieldset = $('.fieldset, .dashboard-form-globalfieldset');
            var $timeInput = $fieldset.find('.input-timerangepicker, .splunk-timerange, [data-view="views/shared/timerangepicker/Master"]').first();
            
            if ($timeInput.length === 0) {
                // Try alternative selectors
                $timeInput = $fieldset.find('.btn-group').has('.dropdown-toggle').first();
            }
            
            if ($timeInput.length === 0) {
                // Try to find by class pattern
                $timeInput = $fieldset.find('[class*="timerange"]').first();
            }
            
            if ($timeInput.length > 0) {
                // Move the time picker element
                $('#duration_picker_target').empty().append($timeInput);
                
                // Style it
                $timeInput.css({
                    'width': '100%'
                });
                $timeInput.find('.btn').css({
                    'width': '100%',
                    'text-align': 'left',
                    'padding': '8px 12px',
                    'border': '1px solid #ccc',
                    'border-radius': '4px'
                });
                
                // Hide the empty fieldset
                $fieldset.hide();
                
                log('Time picker moved to form row', 'success');
                return true;
            } else if (attempts < maxAttempts) {
                setTimeout(tryMove, 250);
                return false;
            } else {
                log('Could not find time picker, using fallback', 'info');
                createFallbackPicker();
                $fieldset.hide();
                return false;
            }
        }
        
        tryMove();
    }
    
    // Fallback dropdown if move fails
    function createFallbackPicker() {
        var html = '<select id="fld_duration_fallback" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:4px;">' +
            '<option value="-1m">Last 1 minute</option>' +
            '<option value="-5m">Last 5 minutes</option>' +
            '<option value="-15m" selected>Last 15 minutes</option>' +
            '<option value="-30m">Last 30 minutes</option>' +
            '<option value="-1h">Last 1 hour</option>' +
            '<option value="-4h">Last 4 hours</option>' +
            '<option value="-24h">Last 24 hours</option>' +
            '<option value="-7d">Last 7 days</option>' +
            '<option value="-30d">Last 30 days</option>' +
            '<option value="@d">Today</option>' +
            '<option value="-1d@d">Yesterday</option>' +
            '<option value="@w0">This week</option>' +
            '<option value="@mon">This month</option>' +
            '<option value="0">All time</option>' +
            '</select>';
        $('#duration_picker_target').html(html);
        
        $(document).on('change', '#fld_duration_fallback', function() {
            // Update tokens manually for fallback
            if (defaultTokens) {
                defaultTokens.set('duration_token.earliest', $(this).val());
                defaultTokens.set('duration_token.latest', 'now');
            }
            updateSummary();
        });
    }
    
    // Helper to get duration values from tokens
    function getDurationValues() {
        var earliest = '-15m';
        var latest = 'now';
        
        // Check fallback first
        if ($('#fld_duration_fallback').length) {
            return { earliest: $('#fld_duration_fallback').val() || '-15m', latest: 'now' };
        }
        
        if (defaultTokens) {
            earliest = defaultTokens.get('duration_token.earliest') || defaultTokens.get('earliest') || '-15m';
            latest = defaultTokens.get('duration_token.latest') || defaultTokens.get('latest') || 'now';
        }
        
        return { earliest: earliest, latest: latest };
    }
    
    // Helper to get human-readable duration
    function getDurationLabel() {
        // Check fallback first
        if ($('#fld_duration_fallback').length) {
            return $('#fld_duration_fallback option:selected').text() || 'Last 15 minutes';
        }
        
        var times = getDurationValues();
        var earliest = times.earliest;
        
        var labels = {
            '-1m': 'Last 1 minute',
            '-5m': 'Last 5 minutes',
            '-15m': 'Last 15 minutes',
            '-30m': 'Last 30 minutes',
            '-60m': 'Last 60 minutes',
            '-1h': 'Last 1 hour',
            '-4h': 'Last 4 hours',
            '-24h': 'Last 24 hours',
            '-7d': 'Last 7 days',
            '-30d': 'Last 30 days',
            '@d': 'Today',
            '-1d@d': 'Yesterday',
            '@w0': 'This week',
            '@mon': 'This month',
            '0': 'All time'
        };
        
        if (labels[earliest]) {
            return labels[earliest];
        }
        return earliest + ' to ' + times.latest;
    }
    
    // ============================================
    // BUILD FULL QUERY WITH EVAL FIELDS
    // ============================================
    function buildFullQuery() {
        var baseQuery = $.trim($('#fld_query').val());
        var alertName = $.trim($('#fld_alert_name').val());
        var appName = $.trim($('#fld_app_name').val());
        var ticketCreation = $('#fld_ticket').val();
        var priority = $('#fld_priority').val() || 'P3';
        var eventClass = $.trim($('#fld_eventclass').val());
        var assignmentGroup = $.trim($('#fld_assignment').val());
        var orgCode = $.trim($('#fld_orgcode').val());
        var emailIds = $.trim($('#fld_email').val());
        var emailSubject = $.trim($('#fld_subject').val());
        var emailBody = $.trim($('#fld_body').val());
        
        // Build eval statement with all required fields
        var evalParts = [];
        evalParts.push('alert_name="' + alertName.replace(/"/g, '\\"') + '"');
        evalParts.push('app_name="' + appName.replace(/"/g, '\\"') + '"');
        evalParts.push('ticket_creation="' + ticketCreation + '"');
        evalParts.push('priority="' + priority + '"');
        
        if (ticketCreation === 'yes') {
            evalParts.push('event_class="' + eventClass.replace(/"/g, '\\"') + '"');
            evalParts.push('assignment_group="' + assignmentGroup.replace(/"/g, '\\"') + '"');
            evalParts.push('org_code="' + orgCode.replace(/"/g, '\\"') + '"');
        }
        
        // Email fields are required
        evalParts.push('email_ids="' + emailIds.replace(/"/g, '\\"') + '"');
        evalParts.push('email_subject="' + emailSubject.replace(/"/g, '\\"') + '"');
        evalParts.push('email_body="' + emailBody.replace(/"/g, '\\"') + '"');
        
        // Construct final query
        var fullQuery = baseQuery + ' | eval ' + evalParts.join(', ');
        
        return fullQuery;
    }
    
    // ============================================
    // LOGGING
    // ============================================
    function log(msg, type) {
        var time = new Date().toLocaleTimeString();
        var color = type === 'error' ? 'color:#c62828' : (type === 'success' ? 'color:#2e7d32' : 'color:#1976d2');
        $('#log').append('<div style="' + color + '">[' + time + '] ' + msg + '</div>');
        $('#log').scrollTop($('#log')[0].scrollHeight);
        console.log('[AlertingFramework] ' + msg);
    }
    
    // ============================================
    // SHOW/HIDE ERROR
    // ============================================
    function showErr(id, msg) {
        $('#fld_' + id).addClass('input-error');
        $('#err_' + id).text(msg).show();
    }
    
    function hideErr(id) {
        $('#fld_' + id).removeClass('input-error');
        $('#err_' + id).text('').hide();
    }
    
    function hideAllErrors() {
        $('.input-error').removeClass('input-error');
        $('[id^="err_"]').text('').hide();
        $('#form-errors').hide().text('');
    }
    
    // ============================================
    // EMAIL VALIDATION
    // ============================================
    function checkEmail(email) {
        if (!email) return false;
        email = $.trim(email);
        if (email === '') return false;
        
        // Check for @ symbol
        var atPos = email.indexOf('@');
        if (atPos < 1) return false;
        
        // Check for dot after @
        var domain = email.substring(atPos + 1);
        var dotPos = domain.lastIndexOf('.');
        if (dotPos < 1) return false;
        
        // Check extension length (at least 2 chars like .co, .com)
        var ext = domain.substring(dotPos + 1);
        if (ext.length < 2) return false;
        
        // Full regex check: user@domain.ext
        var regex = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
        return regex.test(email);
    }
    
    // ============================================
    // VALIDATE ALL FIELDS
    // ============================================
    function validateAll() {
        hideAllErrors();
        
        var errors = [];
        var isTicketYes = $('#fld_ticket').val() === 'yes';
        
        // 1. Alert Name
        var alertName = $.trim($('#fld_alert_name').val());
        if (alertName === '') {
            showErr('alert_name', 'Alert name is required');
            errors.push('Alert Name');
        }
        
        // 2. Application Name
        var appName = $.trim($('#fld_app_name').val());
        if (appName === '') {
            showErr('app_name', 'Application name is required');
            errors.push('Application Name');
        }
        
        // 3. Event Class (only if ticket = yes)
        if (isTicketYes) {
            var eventClass = $.trim($('#fld_eventclass').val());
            if (eventClass === '') {
                showErr('eventclass', 'Event class is required when Ticket Creation is Yes');
                errors.push('Event Class');
            }
        }
        
        // 4. Assignment Group (only if ticket = yes)
        if (isTicketYes) {
            var assignGrp = $.trim($('#fld_assignment').val());
            if (assignGrp === '') {
                showErr('assignment', 'Assignment group is required when Ticket Creation is Yes');
                errors.push('Assignment Group');
            }
        }
        
        // 5. Org Code (only if ticket = yes)
        if (isTicketYes) {
            var orgCode = $.trim($('#fld_orgcode').val());
            if (orgCode === '') {
                showErr('orgcode', 'Org code is required when Ticket Creation is Yes');
                errors.push('Org Code');
            }
        }
        
        // 6. Splunk Query
        var query = $.trim($('#fld_query').val());
        if (query === '') {
            showErr('query', 'Splunk query is required');
            errors.push('Splunk Query');
        }
        
        // 6. Email IDs (required)
        var emailRaw = $.trim($('#fld_email').val());
        if (emailRaw === '') {
            showErr('email', 'Email address is required');
            errors.push('Email IDs');
        } else {
            var emailArr = emailRaw.split(',');
            var badEmails = [];
            for (var i = 0; i < emailArr.length; i++) {
                var em = $.trim(emailArr[i]);
                if (em !== '' && !checkEmail(em)) {
                    badEmails.push(em);
                }
            }
            if (badEmails.length > 0) {
                showErr('email', 'Invalid email format (must be user@domain.com): ' + badEmails.join(', '));
                errors.push('Invalid Email');
            }
        }
        
        // 7. Email Subject (required)
        var subject = $.trim($('#fld_subject').val());
        if (subject === '') {
            showErr('subject', 'Email subject is required');
            errors.push('Email Subject');
        }
        
        // 8. Email Body (required)
        var body = $.trim($('#fld_body').val());
        if (body === '') {
            showErr('body', 'Email body is required');
            errors.push('Email Body');
        }
        
        // 9. Custom Cron (only if frequency is custom)
        if ($('#fld_frequency').val() === 'custom') {
            var customCron = $.trim($('#fld_custom_cron').val());
            if (customCron === '') {
                errors.push('Custom Cron Expression');
                log('Custom cron is required when frequency is set to Custom', 'error');
            }
        }
        
        // Show summary if errors
        if (errors.length > 0) {
            $('#form-errors').html('<strong>Please fix the following errors:</strong> ' + errors.join(', ')).show();
            log('Validation failed: ' + errors.join(', '), 'error');
            return false;
        }
        
        log('Validation passed', 'success');
        return true;
    }
    
    // ============================================
    // TOGGLE TICKET FIELDS
    // ============================================
    function toggleTicketFields() {
        var val = $('#fld_ticket').val();
        console.log('Ticket value changed to: ' + val);
        
        if (val === 'yes') {
            $('#ticket-fields-container').slideDown(200);
            log('Showing ticket fields (Event Class, Assignment Group, Org Code)', 'info');
        } else {
            $('#ticket-fields-container').slideUp(200);
            hideErr('eventclass');
            hideErr('assignment');
            hideErr('orgcode');
            log('Hiding ticket fields', 'info');
        }
        
        updateSummary();
    }
    
    // ============================================
    // UPDATE SUMMARY
    // ============================================
    function updateSummary() {
        $('#sum-name').text($('#fld_alert_name').val() || '-');
        $('#sum-app').text($('#fld_app_name').val() || '-');
        $('#sum-ticket').text($('#fld_ticket').val() === 'yes' ? 'Yes' : 'No');
        $('#sum-email').text($('#fld_email').val() || '-');
        $('#sum-priority').text($('#fld_priority').val() || '-');
        $('#sum-duration').text(getDurationLabel());
        
        // Frequency - handle custom cron
        var freqVal = $('#fld_frequency').val();
        var freqText = $('#fld_frequency option:selected').text();
        if (freqVal === 'custom') {
            var customCron = $.trim($('#fld_custom_cron').val());
            freqText = customCron ? 'Custom: ' + customCron : 'Custom (not set)';
        }
        $('#sum-frequency').text(freqText);
        
        $('#sum-threshold').text($('#fld_threshold').val() || '0');
        
        // Throttle/Suppression display
        var suppText = 'None (Throttle disabled)';
        if ($('#fld_throttle').is(':checked')) {
            var suppVal = parseInt($('#fld_suppression').val()) || 0;
            var suppUnit = $('#fld_suppression_unit').val();
            var unitLabel = suppUnit === 's' ? 'second(s)' : (suppUnit === 'm' ? 'minute(s)' : 'hour(s)');
            suppText = suppVal + ' ' + unitLabel;
        }
        $('#sum-suppression').text(suppText);
        
        // Show full query with eval fields if base query exists
        var baseQuery = $.trim($('#fld_query').val());
        if (baseQuery) {
            var fullQuery = buildFullQuery();
            $('#sum-query').text(fullQuery);
        } else {
            $('#sum-query').text('-');
        }
        
        // Enable ack button if name and query present
        var canAck = $.trim($('#fld_alert_name').val()) !== '' && $.trim($('#fld_query').val()) !== '';
        $('#btn-ack').prop('disabled', !canAck);
    }
    
    // ============================================
    // LOAD MACROS
    // ============================================
    function loadMacros() {
        log('Loading macros...', 'info');
        $('#macros-container').html('Loading...');
        
        var sm = new SearchManager({
            id: 'macros_' + Date.now(),
            search: '| rest /servicesNS/-/-/admin/macros splunk_server=local | table title definition | head 30',
            earliest_time: '-1m',
            latest_time: 'now'
        });
        
        sm.on('search:done', function() {
            var res = sm.data('results');
            if (res) {
                res.on('data', function() {
                    var rows = res.data().rows || [];
                    var fields = res.data().fields || [];
                    macrosList = [];
                    
                    if (rows.length === 0) {
                        $('#macros-container').html('<p>No macros found</p>');
                        return;
                    }
                    
                    var html = '';
                    for (var i = 0; i < rows.length; i++) {
                        var name = rows[i][fields.indexOf('title')] || '';
                        var def = rows[i][fields.indexOf('definition')] || '';
                        macrosList.push({ name: name, def: def });
                        
                        // Truncate definition for display
                        var defDisplay = def.length > 50 ? def.substring(0, 50) + '...' : def;
                        
                        html += '<div style="padding:8px;margin-bottom:8px;background:#f5f5f5;border-radius:4px;overflow:hidden;">';
                        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">';
                        html += '<code style="color:#1976d2;font-size:11px;">`' + name + '`</code>';
                        html += '<button class="btn btn-default btn-xs btn-insert-macro" data-name="' + name + '">Insert</button>';
                        html += '</div>';
                        html += '<div style="font-size:10px;color:#666;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + def.replace(/"/g, '&quot;') + '">' + defDisplay + '</div>';
                        html += '</div>';
                    }
                    
                    $('#macros-container').html(html);
                    log('Loaded ' + macrosList.length + ' macros', 'success');
                });
            }
        });
        
        sm.on('search:error', function() {
            $('#macros-container').html('<p style="color:red;">Error loading macros</p>');
            log('Error loading macros', 'error');
        });
        
        sm.startSearch();
    }
    
    // ============================================
    // LOAD TEMPLATES FROM LOOKUP
    // ============================================
    function loadTemplates() {
        log('Loading templates...', 'info');
        $('#templates-container').html('Loading...');
        
        var sm = new SearchManager({
            id: 'templates_' + Date.now(),
            search: '| inputlookup alert_templates.csv',
            earliest_time: '-1m',
            latest_time: 'now'
        });
        
        sm.on('search:done', function() {
            var res = sm.data('results');
            if (res) {
                res.on('data', function() {
                    var rows = res.data().rows || [];
                    var fields = res.data().fields || [];
                    templatesList = [];
                    
                    if (rows.length === 0) {
                        $('#templates-container').html('<p>No templates found. Add templates to lookups/alert_templates.csv</p>');
                        return;
                    }
                    
                    var html = '';
                    for (var i = 0; i < rows.length; i++) {
                        var tpl = {
                            name: rows[i][fields.indexOf('name')] || '',
                            description: rows[i][fields.indexOf('description')] || '',
                            priority: rows[i][fields.indexOf('priority')] || 'P3',
                            frequency: rows[i][fields.indexOf('frequency')] || '*/15 * * * *',
                            frequency_label: rows[i][fields.indexOf('frequency_label')] || 'Every 15 min',
                            ticket: rows[i][fields.indexOf('ticket')] || 'no',
                            event_class: rows[i][fields.indexOf('event_class')] || '',
                            assignment_group: rows[i][fields.indexOf('assignment_group')] || '',
                            org_code: rows[i][fields.indexOf('org_code')] || '',
                            threshold: rows[i][fields.indexOf('threshold')] || '0',
                            suppression: rows[i][fields.indexOf('suppression')] || '0',
                            duration: rows[i][fields.indexOf('duration')] || '-15m',
                            email: rows[i][fields.indexOf('email')] || '',
                            subject_prefix: rows[i][fields.indexOf('subject_prefix')] || '[ALERT]',
                            email_body: rows[i][fields.indexOf('email_body')] || '',
                            query: rows[i][fields.indexOf('query')] || ''
                        };
                        templatesList.push(tpl);
                        
                        // Priority color
                        var prioColor = '#666';
                        if (tpl.priority === 'P1') prioColor = '#c62828';
                        else if (tpl.priority === 'P2') prioColor = '#f57c00';
                        else if (tpl.priority === 'P3') prioColor = '#1976d2';
                        else if (tpl.priority === 'P4') prioColor = '#388e3c';
                        
                        html += '<div style="padding:8px;margin-bottom:8px;background:#f5f5f5;border-radius:4px;border-left:3px solid ' + prioColor + ';overflow:hidden;">';
                        html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:5px;">';
                        html += '<span style="font-weight:bold;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + tpl.name + '</span>';
                        html += '<span style="display:flex;align-items:center;gap:5px;flex-shrink:0;">';
                        html += '<span style="color:' + prioColor + ';font-weight:bold;font-size:11px;">(' + tpl.priority + ')</span>';
                        html += '<button class="btn btn-primary btn-xs btn-apply-template" data-idx="' + i + '" style="padding:2px 8px;">Apply</button>';
                        html += '</span>';
                        html += '</div>';
                        html += '<div style="font-size:10px;color:#666;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px;" title="' + tpl.description + '">' + tpl.description + '</div>';
                        html += '<div style="font-size:9px;color:#888;margin-top:2px;">' + tpl.frequency_label + ' | Ticket: ' + tpl.ticket + '</div>';
                        html += '</div>';
                    }
                    
                    $('#templates-container').html(html);
                    log('Loaded ' + templatesList.length + ' templates', 'success');
                });
            }
        });
        
        sm.on('search:error', function() {
            $('#templates-container').html('<p style="color:red;">Error loading templates. Make sure alert_templates.csv exists in lookups folder.</p>');
            log('Error loading templates', 'error');
        });
        
        sm.startSearch();
    }
    
    // ============================================
    // RUN PREVIEW SEARCH
    // ============================================
    function runPreview() {
        var baseQuery = $.trim($('#fld_query').val());
        var fullQuery = buildFullQuery();
        var times = getDurationValues();
        var durationText = getDurationLabel();
        
        // Show full query with eval fields
        $('#preview-query').text(fullQuery);
        $('#preview-status').text('Running...').css('color', '#1976d2');
        $('#preview-results').html('<p>Running search...</p>');
        
        // Run with base query for preview (eval fields shown but not executed for performance)
        var sm = new SearchManager({
            id: 'preview_' + Date.now(),
            search: baseQuery,
            earliest_time: times.earliest,
            latest_time: times.latest
        });
        
        var startTime = Date.now();
        
        sm.on('search:done', function() {
            var elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            $('#preview-time').text(elapsed + 's');
            $('#preview-status').text('Complete').css('color', '#2e7d32');
            
            var res = sm.data('results');
            if (res) {
                res.on('data', function() {
                    var rows = res.data().rows || [];
                    var fields = res.data().fields || [];
                    $('#preview-count').text(rows.length + ' results');
                    
                    if (rows.length === 0) {
                        $('#preview-results').html('<p>No results found</p>');
                        return;
                    }
                    
                    var html = '<table class="table table-striped"><thead><tr>';
                    for (var f = 0; f < fields.length; f++) {
                        html += '<th>' + fields[f] + '</th>';
                    }
                    html += '</tr></thead><tbody>';
                    
                    var limit = Math.min(rows.length, 20);
                    for (var r = 0; r < limit; r++) {
                        html += '<tr>';
                        for (var c = 0; c < rows[r].length; c++) {
                            html += '<td>' + (rows[r][c] || '') + '</td>';
                        }
                        html += '</tr>';
                    }
                    html += '</tbody></table>';
                    
                    if (rows.length > 20) {
                        html += '<p>Showing 20 of ' + rows.length + ' results</p>';
                    }
                    
                    $('#preview-results').html(html);
                    log('Preview complete: ' + rows.length + ' results', 'success');
                });
            }
        });
        
        sm.on('search:error', function() {
            $('#preview-status').text('Error').css('color', '#c62828');
            $('#preview-results').html('<p style="color:#c62828;">Search error - check query syntax</p>');
            log('Preview search error', 'error');
        });
        
        sm.startSearch();
    }
    
    // ============================================
    // CREATE ALERT
    // ============================================
    function createAlert() {
        var name = $.trim($('#fld_alert_name').val());
        var appName = $.trim($('#fld_app_name').val());
        var ticketCreation = $('#fld_ticket').val();
        var priority = $('#fld_priority').val() || 'P3';
        var eventClass = $.trim($('#fld_eventclass').val());
        var assignmentGroup = $.trim($('#fld_assignment').val());
        var orgCode = $.trim($('#fld_orgcode').val());
        var cron = $('#fld_frequency').val();
        var times = getDurationValues();
        var threshold = $('#fld_threshold').val() || '0';
        
        // Build full query with all eval fields
        var fullQuery = buildFullQuery();
        
        // Handle custom cron
        if (cron === 'custom') {
            cron = $.trim($('#fld_custom_cron').val());
            if (!cron) {
                $('#form-errors').css('background', '#ffebee').css('color', '#c62828').html('Error: Custom cron expression is required').show();
                log('Custom cron not provided', 'error');
                return;
            }
        }
        
        log('Creating alert: ' + name, 'info');
        
        var params = {
            name: name,
            search: fullQuery,
            is_scheduled: '1',
            cron_schedule: cron,
            'dispatch.earliest_time': times.earliest,
            'dispatch.latest_time': times.latest,
            'alert.track': '1',
            alert_type: 'number of events',
            alert_comparator: 'greater than',
            alert_threshold: threshold
        };
        
        // Add throttle/suppression if enabled
        if ($('#fld_throttle').is(':checked')) {
            var suppVal = parseInt($('#fld_suppression').val()) || 0;
            var suppUnit = $('#fld_suppression_unit').val();
            
            // Convert to seconds
            var suppressionSec = suppVal;
            if (suppUnit === 'm') {
                suppressionSec = suppVal * 60;
            } else if (suppUnit === 'h') {
                suppressionSec = suppVal * 3600;
            }
            
            if (suppressionSec > 0) {
                params['alert.suppress'] = '1';
                params['alert.suppress.period'] = suppressionSec + 's';
            } else {
                params['alert.suppress'] = '0';
            }
        } else {
            params['alert.suppress'] = '0';
        }
        
        // Build actions list
        var actionsList = [];
        
        // Add DFSAlert add-on action (always enabled)
        actionsList.push('DFSAlert');
        params['action.DFSAlert'] = '1';
        params['action.DFSAlert.param.alert_name'] = name;
        params['action.DFSAlert.param.app_name'] = appName;
        params['action.DFSAlert.param.ticket_creation'] = ticketCreation;
        params['action.DFSAlert.param.priority'] = priority;
        
        if (ticketCreation === 'yes') {
            params['action.DFSAlert.param.event_class'] = eventClass;
            params['action.DFSAlert.param.assignment_group'] = assignmentGroup;
            params['action.DFSAlert.param.org_code'] = orgCode;
        }
        
        // Add Log Event action (always enabled)
        actionsList.push('logevent');
        params['action.logevent'] = '1';
        params['action.logevent.param.index'] = 'main';
        params['action.logevent.param.source'] = 'alerting_framework';
        params['action.logevent.param.sourcetype'] = 'alert:dfs';
        params['action.logevent.param.event'] = 'alert_name="' + name + '" app_name="' + appName + '" ticket_creation="' + ticketCreation + '" priority="' + priority + '"';
        
        // Set actions list
        params['actions'] = actionsList.join(', ');
        
        $.ajax({
            url: Splunk.util.make_url('/splunkd/__raw/servicesNS/nobody/alerting_framework/saved/searches'),
            type: 'POST',
            data: params,
            headers: { 'X-Splunk-Form-Key': Splunk.util.getFormKey() },
            success: function(response) {
                $('#form-errors').css('background', '#e8f5e9').css('color', '#2e7d32').html('✓ Alert created successfully: ' + name + ' (with DFSAlert + Log Event actions)').show();
                log('Alert created: ' + name + ' with DFSAlert + Log Event actions', 'success');
            },
            error: function(xhr, status, error) {
                var msg = 'Unknown error';
                console.log('XHR Status:', xhr.status);
                console.log('XHR Response:', xhr.responseText);
                
                try {
                    // Try to parse as JSON
                    var resp = JSON.parse(xhr.responseText);
                    if (resp.messages && resp.messages.length > 0) {
                        msg = resp.messages[0].text;
                    }
                } catch (e) {
                    // Try to extract error from XML response
                    try {
                        var match = xhr.responseText.match(/<msg[^>]*>([^<]+)<\/msg>/);
                        if (match && match[1]) {
                            msg = match[1];
                        } else if (xhr.status === 409) {
                            msg = 'Alert with this name already exists';
                        } else if (xhr.status === 400) {
                            msg = 'Bad request - check alert configuration';
                        } else if (xhr.status === 401 || xhr.status === 403) {
                            msg = 'Permission denied - check your access rights';
                        } else if (error) {
                            msg = error;
                        }
                    } catch (e2) {
                        if (error) msg = error;
                    }
                }
                
                $('#form-errors').css('background', '#ffebee').css('color', '#c62828').html('Error: ' + msg).show();
                log('Create alert failed: ' + msg, 'error');
            }
        });
    }
    
    // ============================================
    // CLEAR FORM
    // ============================================
    function clearForm() {
        $('#fld_alert_name, #fld_app_name, #fld_eventclass, #fld_assignment, #fld_orgcode, #fld_query, #fld_email, #fld_subject, #fld_body').val('');
        $('#fld_ticket').val('no');
        $('#fld_priority').val('P3');
        // Reset time picker (fallback or tokens)
        if ($('#fld_duration_fallback').length) {
            $('#fld_duration_fallback').val('-15m');
        }
        if (defaultTokens) {
            defaultTokens.set('duration_token.earliest', '-15m');
            defaultTokens.set('duration_token.latest', 'now');
        }
        $('#fld_frequency').val('*/15 * * * *');
        $('#fld_custom_cron').val('').hide();
        $('#fld_threshold').val('0');
        // Reset throttle
        $('#fld_throttle').prop('checked', false);
        $('#throttle-options').hide();
        $('#fld_suppression').val('60');
        $('#fld_suppression_unit').val('m');
        hideAllErrors();
        toggleTicketFields();
        isAcknowledged = false;
        $('#btn-ack').removeClass('btn-success').addClass('btn-warning').text('Acknowledge Configuration').prop('disabled', true);
        $('#ack-status').text('');
        $('#preview-query').text('-');
        $('#preview-status').text('Pending');
        $('#preview-time').text('-');
        $('#preview-count').text('-');
        $('#preview-results').html('Click Preview to run');
        updateSummary();
        log('Form cleared', 'info');
    }
    
    // ============================================
    // EVENT HANDLERS
    // ============================================
    
    // Ticket dropdown change
    $(document).on('change', '#fld_ticket', function() {
        toggleTicketFields();
    });
    
    // Throttle checkbox change
    $(document).on('change', '#fld_throttle', function() {
        if ($(this).is(':checked')) {
            $('#throttle-options').show();
        } else {
            $('#throttle-options').hide();
        }
        updateSummary();
    });
    
    // Frequency dropdown change - show/hide custom cron input
    $(document).on('change', '#fld_frequency', function() {
        if ($(this).val() === 'custom') {
            $('#fld_custom_cron').show().focus();
        } else {
            $('#fld_custom_cron').hide().val('');
        }
        updateSummary();
    });
    
    // Custom cron input change
    $(document).on('input', '#fld_custom_cron', function() {
        updateSummary();
    });
    
    // Field input changes
    $(document).on('input change', '#fld_alert_name, #fld_app_name, #fld_query, #fld_email, #fld_subject, #fld_priority, #fld_threshold, #fld_suppression, #fld_suppression_unit', function() {
        updateSummary();
    });
    
    // Refresh macros
    $(document).on('click', '#btn-refresh-macros', function() {
        loadMacros();
    });
    
    // Insert macro
    $(document).on('click', '.btn-insert-macro', function() {
        var name = $(this).data('name');
        var current = $('#fld_query').val();
        $('#fld_query').val(current + '`' + name + '`');
        log('Inserted macro: ' + name, 'info');
        updateSummary();
    });
    
    // Use example
    $(document).on('click', '.btn-use-example', function() {
        var q = $(this).data('query');
        $('#fld_query').val(q);
        log('Applied example query', 'info');
        updateSummary();
    });
    
    // Apply template from lookup - fills ALL form fields
    $(document).on('click', '.btn-apply-template', function() {
        var idx = parseInt($(this).data('idx'));
        if (idx >= 0 && idx < templatesList.length) {
            var tpl = templatesList[idx];
            
            // Alert Name - use template name as prefix
            $('#fld_alert_name').val(tpl.name + ' - ');
            
            // Application Name (user should fill this)
            // $('#fld_app_name').val('');
            
            // Ticket Creation
            $('#fld_ticket').val(tpl.ticket);
            
            // Ticket fields (Event Class, Assignment Group, Org Code)
            if (tpl.ticket === 'yes') {
                $('#fld_eventclass').val(tpl.event_class || '');
                $('#fld_assignment').val(tpl.assignment_group || '');
                $('#fld_orgcode').val(tpl.org_code || '');
            }
            
            // Splunk Query
            if (tpl.query) {
                $('#fld_query').val(tpl.query);
            }
            
            // Email
            if (tpl.email) {
                $('#fld_email').val(tpl.email);
            }
            
            // Email Subject
            $('#fld_subject').val(tpl.subject_prefix + ' $name$');
            
            // Email Body
            if (tpl.email_body) {
                $('#fld_body').val(tpl.email_body);
            }
            
            // Priority
            $('#fld_priority').val(tpl.priority);
            
            // Duration - set token if available
            if (tpl.duration && defaultTokens) {
                defaultTokens.set('duration_token.earliest', tpl.duration);
                defaultTokens.set('duration_token.latest', 'now');
            }
            // Also set fallback dropdown if exists
            if ($('#fld_duration_fallback').length && tpl.duration) {
                $('#fld_duration_fallback').val(tpl.duration);
            }
            
            // Frequency
            $('#fld_frequency').val(tpl.frequency);
            // Hide custom cron if not custom
            if (tpl.frequency !== 'custom') {
                $('#fld_custom_cron').hide().val('');
            }
            
            // Threshold
            $('#fld_threshold').val(tpl.threshold || '0');
            
            // Throttle/Suppression - enable if suppression > 0
            var suppVal = parseInt(tpl.suppression) || 0;
            if (suppVal > 0) {
                $('#fld_throttle').prop('checked', true);
                $('#throttle-options').show();
                $('#fld_suppression').val(suppVal);
                $('#fld_suppression_unit').val('m'); // Templates store in minutes
            } else {
                $('#fld_throttle').prop('checked', false);
                $('#throttle-options').hide();
                $('#fld_suppression').val('60');
                $('#fld_suppression_unit').val('m');
            }
            
            // Toggle ticket fields visibility
            toggleTicketFields();
            
            // Update summary
            updateSummary();
            
            // Scroll to form
            $('html, body').animate({
                scrollTop: $('#fld_alert_name').offset().top - 100
            }, 300);
            
            // Focus on alert name for user to complete it
            $('#fld_alert_name').focus().select();
            
            log('Applied template: ' + tpl.name + ' (' + tpl.priority + ') - All fields updated', 'success');
        }
    });
    
    // Refresh templates
    $(document).on('click', '#btn-refresh-templates', function() {
        loadTemplates();
    });
    
    // Expand macros - replace in query field
    $(document).on('click', '#btn-expand-macros', function() {
        var q = $('#fld_query').val();
        if (!q || $.trim(q) === '') {
            log('No query to expand', 'error');
            return;
        }
        
        var expanded = q;
        var count = 0;
        
        for (var i = 0; i < macrosList.length; i++) {
            var macroName = macrosList[i].name;
            var macroDef = macrosList[i].def;
            var pattern = '`' + macroName + '`';
            
            if (expanded.indexOf(pattern) !== -1) {
                expanded = expanded.split(pattern).join(macroDef);
                count++;
                log('Expanded macro: `' + macroName + '` → ' + macroDef, 'info');
            }
        }
        
        if (count > 0) {
            $('#fld_query').val(expanded);
            $('#preview-query').text('Expanded ' + count + ' macro(s):\n' + expanded);
            log('Expanded ' + count + ' macro(s) in query', 'success');
        } else {
            log('No macros found to expand', 'info');
            $('#preview-query').text('No macros found in query');
        }
    });
    
    // Validate query
    $(document).on('click', '#btn-validate-query', function() {
        var q = $.trim($('#fld_query').val());
        if (q === '') {
            $('#query-status').text('No query').css('color', '#c62828');
            return;
        }
        
        $('#query-status').text('Validating...').css('color', '#1976d2');
        
        var sm = new SearchManager({
            id: 'validate_' + Date.now(),
            search: q + ' | head 1',
            earliest_time: '-1m',
            latest_time: 'now'
        });
        
        sm.on('search:done', function() {
            $('#query-status').text('✓ Valid').css('color', '#2e7d32');
            log('Query syntax valid', 'success');
        });
        
        sm.on('search:error', function() {
            $('#query-status').text('✗ Invalid').css('color', '#c62828');
            log('Query syntax invalid', 'error');
        });
        
        sm.startSearch();
    });
    
    // PREVIEW BUTTON
    $(document).on('click', '#btn-preview', function() {
        log('Preview clicked - validating form...', 'info');
        
        var isValid = validateAll();
        
        if (!isValid) {
            // Scroll to first error
            var firstError = $('.input-error:first');
            if (firstError.length > 0) {
                $('html, body').animate({
                    scrollTop: firstError.offset().top - 100
                }, 300);
            }
            return;
        }
        
        runPreview();
    });
    
    // SUBMIT BUTTON
    $(document).on('click', '#btn-submit', function() {
        log('Submit clicked - validating form...', 'info');
        
        var isValid = validateAll();
        
        if (!isValid) {
            var firstError = $('.input-error:first');
            if (firstError.length > 0) {
                $('html, body').animate({
                    scrollTop: firstError.offset().top - 100
                }, 300);
            }
            return;
        }
        
        if (!isAcknowledged) {
            $('#form-errors').css('background', '#ffebee').css('color', '#c62828').html('Please acknowledge the configuration first').show();
            log('Configuration not acknowledged', 'error');
            return;
        }
        
        createAlert();
    });
    
    // CLEAR BUTTON
    $(document).on('click', '#btn-clear', function() {
        if (confirm('Clear the form?')) {
            clearForm();
        }
    });
    
    // ACKNOWLEDGE BUTTON
    $(document).on('click', '#btn-ack', function() {
        isAcknowledged = true;
        $(this).removeClass('btn-warning').addClass('btn-success').text('✓ Acknowledged');
        $('#ack-status').text('Ready to submit').css('color', '#2e7d32');
        log('Configuration acknowledged', 'success');
    });
    
    // LOAD ALERTS
    $(document).on('click', '#btn-load-alerts', function() {
        log('Loading existing alerts...', 'info');
        $('#alerts-list').html('Loading...');
        
        var sm = new SearchManager({
            id: 'alerts_' + Date.now(),
            search: '| rest /servicesNS/-/-/saved/searches splunk_server=local | where is_scheduled=1 | table title cron_schedule disabled | head 50',
            earliest_time: '-1m',
            latest_time: 'now'
        });
        
        sm.on('search:done', function() {
            var res = sm.data('results');
            if (res) {
                res.on('data', function() {
                    var rows = res.data().rows || [];
                    var fields = res.data().fields || [];
                    
                    if (rows.length === 0) {
                        $('#alerts-list').html('<p>No scheduled alerts found</p>');
                        return;
                    }
                    
                    var html = '<table class="table table-striped"><thead><tr><th>Name</th><th>Schedule</th><th>Status</th></tr></thead><tbody>';
                    for (var i = 0; i < rows.length; i++) {
                        var name = rows[i][fields.indexOf('title')] || '';
                        var cron = rows[i][fields.indexOf('cron_schedule')] || '';
                        var dis = rows[i][fields.indexOf('disabled')] === '1';
                        html += '<tr><td>' + name + '</td><td>' + cron + '</td><td>' + (dis ? 'Disabled' : 'Enabled') + '</td></tr>';
                    }
                    html += '</tbody></table>';
                    
                    $('#alerts-list').html(html);
                    log('Loaded ' + rows.length + ' alerts', 'success');
                });
            }
        });
        
        sm.startSearch();
    });
    
    // FILTER ALERTS
    $(document).on('input', '#alert-filter', function() {
        var filter = $(this).val().toLowerCase();
        $('#alerts-list tbody tr').each(function() {
            var name = $(this).find('td:first').text().toLowerCase();
            $(this).toggle(name.indexOf(filter) !== -1);
        });
    });
    
    // CLEAR LOG
    $(document).on('click', '#btn-clear-log', function() {
        $('#log').html('[' + new Date().toLocaleTimeString() + '] Log cleared');
    });
    
    // TOGGLE QUICK START
    $(document).on('click', '#quick-start-header', function() {
        var $row = $('#quick_start_content').closest('.dashboard-row');
        var $icon = $('#qs-icon');
        if ($row.is(':visible')) {
            $row.slideUp(300);
            $icon.text('▶');
        } else {
            $row.slideDown(300);
            $icon.text('▼');
        }
    });
    
    // ============================================
    // INITIALIZATION
    // ============================================
    $(document).ready(function() {
        log('Alerting Framework initialized', 'success');
        
        // Hide quick start section by default (collapsed)
        setTimeout(function() {
            $('#quick_start_content').closest('.dashboard-row').hide();
            $('#qs-icon').text('▶');
        }, 100);
        
        // Move time picker to form row
        setTimeout(function() {
            moveTimePicker();
        }, 300);
        
        // Listen for time picker token changes
        if (defaultTokens) {
            defaultTokens.on('change:duration_token.earliest change:duration_token.latest', function() {
                updateSummary();
                log('Time range changed: ' + getDurationLabel(), 'info');
            });
        }
        
        loadMacros();
        loadTemplates();
        toggleTicketFields();
        updateSummary();
    });
    
});
