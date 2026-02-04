require([
    'jquery',
    'underscore',
    'splunkjs/mvc',
    'splunkjs/mvc/simplexml/ready!'
], function($, _, mvc) {
    
    // ============================================
    // CROSS-VERSION COMPATIBILITY (Splunk 9.x + 10.x)
    // ============================================
    function makeUrl(path) {
        try {
            if (typeof Splunk !== 'undefined' && Splunk.util && Splunk.util.make_url) {
                return Splunk.util.make_url(path);
            }
        } catch(e) {}
        var prefix = '';
        var localeMatch = window.location.pathname.match(/^(\/[a-z]{2}-[A-Z]{2})/);
        if (localeMatch) {
            prefix = localeMatch[1];
        }
        return prefix + path;
    }
    
    function getFormKey() {
        try {
            if (typeof Splunk !== 'undefined' && Splunk.util && Splunk.util.getFormKey) {
                return Splunk.util.getFormKey();
            }
        } catch(e) {}
        var cookies = document.cookie.split(';');
        for (var i = 0; i < cookies.length; i++) {
            var cookie = $.trim(cookies[i]);
            if (cookie.indexOf('splunkweb_csrf_token_') === 0) {
                return cookie.split('=')[1];
            }
        }
        var csrfInput = $('input[name="splunk_form_key"]');
        if (csrfInput.length > 0) {
            return csrfInput.val();
        }
        return '';
    }
    
    // State
    var allAlerts = [];
    var filteredAlerts = [];
    var selectedAlerts = [];
    var currentPage = 1;
    var pageSize = 20;
    var currentAlertData = null;
    
    // ============================================
    // LOGGING
    // ============================================
    function log(msg, type) {
        var time = new Date().toLocaleTimeString();
        var colorClass = type === 'error' ? 'log-error' : (type === 'success' ? 'log-success' : 'log-info');
        $('#activity-log').prepend('<div class="log-entry ' + colorClass + '">[' + time + '] ' + msg + '</div>');
        console.log('[AlertManagement] ' + msg);
    }
    
    // ============================================
    // LOAD ALERTS AND REPORTS
    // ============================================
    function loadAlerts() {
        log('Loading alerts and reports...', 'info');
        $('#alerts-tbody').html('<tr><td colspan="7" style="text-align:center;padding:40px;"><span class="loading-text">Loading...</span></td></tr>');
        
        $.ajax({
            url: makeUrl('/splunkd/__raw/servicesNS/-/-/saved/searches'),
            type: 'GET',
            data: {
                output_mode: 'json',
                count: 0,
                search: 'is_scheduled=1 OR alert_type=*'
            },
            success: function(response) {
                allAlerts = [];
                
                if (response && response.entry) {
                    response.entry.forEach(function(entry) {
                        var content = entry.content || {};
                        var isScheduled = content.is_scheduled === true || content.is_scheduled === '1';
                        var hasAlertType = content.alert_type && content.alert_type !== '';
                        
                        // Include if scheduled or has alert configuration
                        if (isScheduled || hasAlertType) {
                            var alertType = 'report';
                            if (content.alert_type && content.alert_type !== 'always') {
                                alertType = 'alert';
                            }
                            if (content.actions && content.actions !== '') {
                                alertType = 'alert';
                            }
                            
                            allAlerts.push({
                                name: entry.name,
                                id: entry.name,
                                type: alertType,
                                owner: entry.acl ? entry.acl.owner : '-',
                                app: entry.acl ? entry.acl.app : '-',
                                disabled: content.disabled === true || content.disabled === '1',
                                search: content.search || '',
                                cron: content.cron_schedule || '-',
                                earliest: content['dispatch.earliest_time'] || '-',
                                latest: content['dispatch.latest_time'] || '-',
                                alertType: content.alert_type || '-',
                                alertComparator: content.alert_comparator || '-',
                                alertThreshold: content.alert_threshold || '-',
                                actions: content.actions || '-',
                                suppressPeriod: content['alert.suppress.period'] || '-',
                                suppress: content['alert.suppress'] === '1' || content['alert.suppress'] === true
                            });
                        }
                    });
                }
                
                log('Loaded ' + allAlerts.length + ' alerts/reports', 'success');
                updateStats();
                populateAppDropdown();
                applyFilters();
            },
            error: function(xhr, status, error) {
                log('Failed to load alerts: ' + error, 'error');
                $('#alerts-tbody').html('<tr><td colspan="7" style="text-align:center;padding:40px;color:#c62828;">Error loading alerts. Please try again.</td></tr>');
            }
        });
    }
    
    // ============================================
    // UPDATE STATS
    // ============================================
    function updateStats() {
        var total = allAlerts.length;
        var enabled = allAlerts.filter(function(a) { return !a.disabled; }).length;
        var disabled = total - enabled;
        
        $('#total-count').text(total);
        $('#enabled-count').text(enabled);
        $('#disabled-count').text(disabled);
    }
    
    // ============================================
    // POPULATE APP DROPDOWN
    // ============================================
    function populateAppDropdown() {
        var apps = [];
        allAlerts.forEach(function(alert) {
            if (alert.app && apps.indexOf(alert.app) === -1) {
                apps.push(alert.app);
            }
        });
        
        apps.sort();
        
        var html = '<option value="all">All Apps</option>';
        apps.forEach(function(app) {
            html += '<option value="' + escapeHtml(app) + '">' + escapeHtml(app) + '</option>';
        });
        
        $('#filter-app').html(html);
    }
    
    // ============================================
    // APPLY FILTERS
    // ============================================
    function applyFilters() {
        var searchTerm = $('#search-input').val().toLowerCase();
        var querySearchTerm = $('#search-query').val().toLowerCase();
        var appFilter = $('#filter-app').val();
        var typeFilter = $('#filter-type').val();
        var statusFilter = $('#filter-status').val();
        
        filteredAlerts = allAlerts.filter(function(alert) {
            // Search filter by name
            if (searchTerm && alert.name.toLowerCase().indexOf(searchTerm) === -1) {
                return false;
            }
            
            // Search filter by SPL query
            if (querySearchTerm && alert.search.toLowerCase().indexOf(querySearchTerm) === -1) {
                return false;
            }
            
            // App filter
            if (appFilter !== 'all' && alert.app !== appFilter) {
                return false;
            }
            
            // Type filter
            if (typeFilter !== 'all' && alert.type !== typeFilter) {
                return false;
            }
            
            // Status filter
            if (statusFilter === 'enabled' && alert.disabled) {
                return false;
            }
            if (statusFilter === 'disabled' && !alert.disabled) {
                return false;
            }
            
            return true;
        });
        
        currentPage = 1;
        selectedAlerts = [];
        updateSelectAllCheckbox();
        renderTable();
    }
    
    // ============================================
    // RENDER TABLE
    // ============================================
    function renderTable() {
        var start = (currentPage - 1) * pageSize;
        var end = start + pageSize;
        var pageAlerts = filteredAlerts.slice(start, end);
        
        if (pageAlerts.length === 0) {
            $('#alerts-tbody').html('<tr><td colspan="8" style="text-align:center;padding:40px;">No alerts or reports found matching your criteria.</td></tr>');
            $('#showing-text').text('Showing 0 of ' + filteredAlerts.length);
            $('#btn-prev').prop('disabled', true);
            $('#btn-next').prop('disabled', true);
            return;
        }
        
        var html = '';
        pageAlerts.forEach(function(alert) {
            var isSelected = selectedAlerts.indexOf(alert.name) !== -1;
            var statusClass = alert.disabled ? 'status-disabled' : 'status-enabled';
            var statusText = alert.disabled ? 'Disabled' : 'Enabled';
            
            html += '<tr class="alert-row ' + (isSelected ? 'selected' : '') + '" data-name="' + escapeHtml(alert.name) + '">';
            html += '<td><input type="checkbox" class="alert-checkbox" data-name="' + escapeHtml(alert.name) + '" ' + (isSelected ? 'checked' : '') + '/></td>';
            html += '<td class="alert-name-cell"><span class="alert-name" data-name="' + escapeHtml(alert.name) + '">' + escapeHtml(alert.name) + '</span></td>';
            html += '<td><span class="app-badge">' + escapeHtml(alert.app) + '</span></td>';
            html += '<td><span class="type-badge type-' + alert.type + '">' + capitalize(alert.type) + '</span></td>';
            html += '<td><span class="status-badge ' + statusClass + '">' + statusText + '</span></td>';
            html += '<td>' + escapeHtml(alert.owner) + '</td>';
            html += '<td>' + escapeHtml(cronToReadable(alert.cron)) + '</td>';
            html += '<td class="actions-cell">';
            html += '<button class="btn btn-xs btn-primary btn-edit" data-name="' + escapeHtml(alert.name) + '" title="Edit">Edit</button> ';
            if (alert.disabled) {
                html += '<button class="btn btn-xs btn-success btn-enable" data-name="' + escapeHtml(alert.name) + '" title="Enable">Enable</button> ';
            } else {
                html += '<button class="btn btn-xs btn-warning btn-disable" data-name="' + escapeHtml(alert.name) + '" title="Disable">Disable</button> ';
            }
            html += '<button class="btn btn-xs btn-danger btn-delete" data-name="' + escapeHtml(alert.name) + '" title="Delete">Delete</button>';
            html += '</td>';
            html += '</tr>';
        });
        
        $('#alerts-tbody').html(html);
        
        // Update pagination
        var totalPages = Math.ceil(filteredAlerts.length / pageSize);
        $('#showing-text').text('Showing ' + (start + 1) + '-' + Math.min(end, filteredAlerts.length) + ' of ' + filteredAlerts.length);
        $('#page-info').text('Page ' + currentPage + ' of ' + totalPages);
        $('#btn-prev').prop('disabled', currentPage <= 1);
        $('#btn-next').prop('disabled', currentPage >= totalPages);
        
        updateBulkButtons();
    }
    
    // ============================================
    // HELPER FUNCTIONS
    // ============================================
    function escapeHtml(text) {
        if (!text) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
    
    function capitalize(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }
    
    function cronToReadable(cron) {
        if (!cron || cron === '-') return '-';
        
        var cronMap = {
            '*/5 * * * *': 'Every 5 min',
            '*/15 * * * *': 'Every 15 min',
            '*/30 * * * *': 'Every 30 min',
            '0 * * * *': 'Hourly',
            '0 */4 * * *': 'Every 4 hours',
            '0 0 * * *': 'Daily (midnight)',
            '0 8 * * *': 'Daily (8 AM)',
            '0 0 * * 0': 'Weekly (Sunday)',
            '0 0 1 * *': 'Monthly (1st)'
        };
        
        return cronMap[cron] || cron;
    }
    
    function updateSelectAllCheckbox() {
        var pageAlertNames = getCurrentPageAlertNames();
        var allSelected = pageAlertNames.length > 0 && pageAlertNames.every(function(name) {
            return selectedAlerts.indexOf(name) !== -1;
        });
        $('#select-all').prop('checked', allSelected);
    }
    
    function getCurrentPageAlertNames() {
        var start = (currentPage - 1) * pageSize;
        var end = start + pageSize;
        return filteredAlerts.slice(start, end).map(function(a) { return a.name; });
    }
    
    function updateBulkButtons() {
        var hasSelection = selectedAlerts.length > 0;
        $('#btn-bulk-enable, #btn-bulk-disable, #btn-bulk-delete').prop('disabled', !hasSelection);
    }
    
    function getAlertByName(name) {
        return allAlerts.find(function(a) { return a.name === name; });
    }
    
    // ============================================
    // SHOW ALERT DETAILS MODAL
    // ============================================
    function showAlertDetails(alertName) {
        var alert = getAlertByName(alertName);
        if (!alert) {
            log('Alert not found: ' + alertName, 'error');
            return;
        }
        
        currentAlertData = alert;
        
        $('#modal-title').text(alert.type === 'alert' ? 'Alert Details' : 'Report Details');
        $('#detail-name').text(alert.name);
        $('#detail-type').html('<span class="type-badge type-' + alert.type + '">' + capitalize(alert.type) + '</span>');
        $('#detail-status').html('<span class="status-badge ' + (alert.disabled ? 'status-disabled' : 'status-enabled') + '">' + (alert.disabled ? 'Disabled' : 'Enabled') + '</span>');
        $('#detail-owner').text(alert.owner);
        $('#detail-app').text(alert.app);
        $('#detail-cron').text(alert.cron + ' (' + cronToReadable(alert.cron) + ')');
        $('#detail-timerange').text(alert.earliest + ' to ' + alert.latest);
        $('#detail-trigger').text(alert.alertType + ' ' + alert.alertComparator + ' ' + alert.alertThreshold);
        $('#detail-actions').text(alert.actions);
        $('#detail-throttle').text(alert.suppress ? 'Yes (' + alert.suppressPeriod + ')' : 'No');
        $('#detail-query').text(alert.search);
        
        // Update modal buttons based on status
        if (alert.disabled) {
            $('#btn-modal-enable').show();
            $('#btn-modal-disable').hide();
        } else {
            $('#btn-modal-enable').hide();
            $('#btn-modal-disable').show();
        }
        
        $('#alert-modal').fadeIn(200);
        log('Viewing details for: ' + alertName, 'info');
    }
    
    // ============================================
    // ENABLE/DISABLE ALERT
    // ============================================
    function enableAlert(alertName, callback) {
        log('Enabling alert: ' + alertName, 'info');
        
        $.ajax({
            url: makeUrl('/splunkd/__raw/servicesNS/-/-/saved/searches/' + encodeURIComponent(alertName)),
            type: 'POST',
            data: { disabled: '0' },
            headers: { 'X-Splunk-Form-Key': getFormKey() },
            success: function() {
                log('Alert enabled: ' + alertName, 'success');
                if (callback) callback(true);
            },
            error: function(xhr, status, error) {
                log('Failed to enable alert: ' + error, 'error');
                if (callback) callback(false);
            }
        });
    }
    
    function disableAlert(alertName, callback) {
        log('Disabling alert: ' + alertName, 'info');
        
        $.ajax({
            url: makeUrl('/splunkd/__raw/servicesNS/-/-/saved/searches/' + encodeURIComponent(alertName)),
            type: 'POST',
            data: { disabled: '1' },
            headers: { 'X-Splunk-Form-Key': getFormKey() },
            success: function() {
                log('Alert disabled: ' + alertName, 'success');
                if (callback) callback(true);
            },
            error: function(xhr, status, error) {
                log('Failed to disable alert: ' + error, 'error');
                if (callback) callback(false);
            }
        });
    }
    
    // ============================================
    // DELETE ALERT
    // ============================================
    function deleteAlert(alertName, callback) {
        log('Deleting alert: ' + alertName, 'info');
        
        $.ajax({
            url: makeUrl('/splunkd/__raw/servicesNS/-/-/saved/searches/' + encodeURIComponent(alertName)),
            type: 'DELETE',
            headers: { 'X-Splunk-Form-Key': getFormKey() },
            success: function() {
                log('Alert deleted: ' + alertName, 'success');
                if (callback) callback(true);
            },
            error: function(xhr, status, error) {
                log('Failed to delete alert: ' + error, 'error');
                if (callback) callback(false);
            }
        });
    }
    
    // ============================================
    // BULK OPERATIONS
    // ============================================
    function bulkEnable() {
        if (selectedAlerts.length === 0) return;
        
        var count = selectedAlerts.length;
        var completed = 0;
        var success = 0;
        
        log('Bulk enabling ' + count + ' alerts...', 'info');
        
        selectedAlerts.forEach(function(name) {
            enableAlert(name, function(ok) {
                completed++;
                if (ok) success++;
                
                if (completed === count) {
                    log('Bulk enable complete: ' + success + '/' + count + ' successful', success === count ? 'success' : 'error');
                    selectedAlerts = [];
                    loadAlerts();
                }
            });
        });
    }
    
    function bulkDisable() {
        if (selectedAlerts.length === 0) return;
        
        var count = selectedAlerts.length;
        var completed = 0;
        var success = 0;
        
        log('Bulk disabling ' + count + ' alerts...', 'info');
        
        selectedAlerts.forEach(function(name) {
            disableAlert(name, function(ok) {
                completed++;
                if (ok) success++;
                
                if (completed === count) {
                    log('Bulk disable complete: ' + success + '/' + count + ' successful', success === count ? 'success' : 'error');
                    selectedAlerts = [];
                    loadAlerts();
                }
            });
        });
    }
    
    function bulkDelete() {
        if (selectedAlerts.length === 0) return;
        
        var count = selectedAlerts.length;
        var completed = 0;
        var success = 0;
        
        log('Bulk deleting ' + count + ' alerts...', 'info');
        
        selectedAlerts.forEach(function(name) {
            deleteAlert(name, function(ok) {
                completed++;
                if (ok) success++;
                
                if (completed === count) {
                    log('Bulk delete complete: ' + success + '/' + count + ' successful', success === count ? 'success' : 'error');
                    selectedAlerts = [];
                    loadAlerts();
                }
            });
        });
    }
    
    // ============================================
    // CONFIRMATION MODAL
    // ============================================
    var confirmCallback = null;
    
    function showConfirm(title, message, callback) {
        $('#confirm-title').text(title);
        $('#confirm-message').text(message);
        confirmCallback = callback;
        $('#confirm-modal').fadeIn(200);
    }
    
    // ============================================
    // EVENT HANDLERS
    // ============================================
    
    // Search and filter
    var searchTimeout;
    $(document).on('input', '#search-input', function() {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(applyFilters, 300);
    });
    
    $(document).on('input', '#search-query', function() {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(applyFilters, 300);
    });
    
    $(document).on('change', '#filter-app, #filter-type, #filter-status', applyFilters);
    
    // Refresh button
    $(document).on('click', '#btn-refresh', loadAlerts);
    
    // Select all checkbox
    $(document).on('change', '#select-all', function() {
        var isChecked = $(this).is(':checked');
        var pageAlertNames = getCurrentPageAlertNames();
        
        if (isChecked) {
            pageAlertNames.forEach(function(name) {
                if (selectedAlerts.indexOf(name) === -1) {
                    selectedAlerts.push(name);
                }
            });
        } else {
            pageAlertNames.forEach(function(name) {
                var idx = selectedAlerts.indexOf(name);
                if (idx !== -1) {
                    selectedAlerts.splice(idx, 1);
                }
            });
        }
        
        renderTable();
    });
    
    // Individual checkbox
    $(document).on('change', '.alert-checkbox', function() {
        var name = $(this).data('name');
        var isChecked = $(this).is(':checked');
        
        if (isChecked) {
            if (selectedAlerts.indexOf(name) === -1) {
                selectedAlerts.push(name);
            }
        } else {
            var idx = selectedAlerts.indexOf(name);
            if (idx !== -1) {
                selectedAlerts.splice(idx, 1);
            }
        }
        
        updateSelectAllCheckbox();
        updateBulkButtons();
        $(this).closest('tr').toggleClass('selected', isChecked);
    });
    
    // Click on alert name to show details
    $(document).on('click', '.alert-name', function() {
        var name = $(this).data('name');
        showAlertDetails(name);
    });
    
    // Individual action buttons
    $(document).on('click', '.btn-edit', function(e) {
        e.stopPropagation();
        var name = $(this).data('name');
        // Navigate to alerting framework with alert name as parameter - open in new tab
        window.open(makeUrl('/app/alerting_framework/alerting_framework?alert=' + encodeURIComponent(name)), '_blank');
    });
    
    $(document).on('click', '.btn-enable', function(e) {
        e.stopPropagation();
        var name = $(this).data('name');
        enableAlert(name, function(ok) {
            if (ok) loadAlerts();
        });
    });
    
    $(document).on('click', '.btn-disable', function(e) {
        e.stopPropagation();
        var name = $(this).data('name');
        disableAlert(name, function(ok) {
            if (ok) loadAlerts();
        });
    });
    
    $(document).on('click', '.btn-delete', function(e) {
        e.stopPropagation();
        var name = $(this).data('name');
        showConfirm('Delete Alert', 'Are you sure you want to delete "' + name + '"? This action cannot be undone.', function() {
            deleteAlert(name, function(ok) {
                if (ok) loadAlerts();
            });
        });
    });
    
    // Bulk buttons
    $(document).on('click', '#btn-bulk-enable', function() {
        showConfirm('Enable Alerts', 'Are you sure you want to enable ' + selectedAlerts.length + ' selected alert(s)?', bulkEnable);
    });
    
    $(document).on('click', '#btn-bulk-disable', function() {
        showConfirm('Disable Alerts', 'Are you sure you want to disable ' + selectedAlerts.length + ' selected alert(s)?', bulkDisable);
    });
    
    $(document).on('click', '#btn-bulk-delete', function() {
        showConfirm('Delete Alerts', 'Are you sure you want to delete ' + selectedAlerts.length + ' selected alert(s)? This action cannot be undone.', bulkDelete);
    });
    
    // Pagination
    $(document).on('click', '#btn-prev', function() {
        if (currentPage > 1) {
            currentPage--;
            renderTable();
        }
    });
    
    $(document).on('click', '#btn-next', function() {
        var totalPages = Math.ceil(filteredAlerts.length / pageSize);
        if (currentPage < totalPages) {
            currentPage++;
            renderTable();
        }
    });
    
    // Modal close
    $(document).on('click', '#modal-close, #btn-modal-close', function() {
        $('#alert-modal').fadeOut(200);
        currentAlertData = null;
    });
    
    $(document).on('click', '#alert-modal', function(e) {
        if ($(e.target).hasClass('modal-overlay')) {
            $('#alert-modal').fadeOut(200);
            currentAlertData = null;
        }
    });
    
    // Modal action buttons
    $(document).on('click', '#btn-modal-edit', function() {
        if (currentAlertData) {
            window.open(makeUrl('/app/alerting_framework/alerting_framework?alert=' + encodeURIComponent(currentAlertData.name)), '_blank');
        }
    });
    
    $(document).on('click', '#btn-modal-enable', function() {
        if (currentAlertData) {
            enableAlert(currentAlertData.name, function(ok) {
                if (ok) {
                    $('#alert-modal').fadeOut(200);
                    loadAlerts();
                }
            });
        }
    });
    
    $(document).on('click', '#btn-modal-disable', function() {
        if (currentAlertData) {
            disableAlert(currentAlertData.name, function(ok) {
                if (ok) {
                    $('#alert-modal').fadeOut(200);
                    loadAlerts();
                }
            });
        }
    });
    
    $(document).on('click', '#btn-modal-delete', function() {
        if (currentAlertData) {
            showConfirm('Delete Alert', 'Are you sure you want to delete "' + currentAlertData.name + '"? This action cannot be undone.', function() {
                deleteAlert(currentAlertData.name, function(ok) {
                    if (ok) {
                        $('#alert-modal').fadeOut(200);
                        loadAlerts();
                    }
                });
            });
        }
    });
    
    // Confirmation modal
    $(document).on('click', '#confirm-close, #btn-confirm-no', function() {
        $('#confirm-modal').fadeOut(200);
        confirmCallback = null;
    });
    
    $(document).on('click', '#btn-confirm-yes', function() {
        $('#confirm-modal').fadeOut(200);
        if (confirmCallback) {
            confirmCallback();
            confirmCallback = null;
        }
    });
    
    // Clear log
    $(document).on('click', '#btn-clear-log', function() {
        $('#activity-log').html('<div class="log-entry">[Ready] Log cleared</div>');
    });
    
    // ============================================
    // INITIALIZE
    // ============================================
    $(document).ready(function() {
        log('Alert Management Dashboard initialized', 'success');
        loadAlerts();
    });
    
});
