require([
    'jquery',
    'underscore',
    'splunkjs/mvc',
    'splunkjs/mvc/simplexml/ready!'
], function($, _, mvc) {

    // Prevent double initialization (SimpleXML can fire require callback twice)
    if (window._AM_LOADED) { console.log('[AM] Already loaded, skipping duplicate init.'); return; }
    window._AM_LOADED = true;

    console.log('[AM] ======= Alert Management v4 loaded =======');

    // ============================================================
    // BULLETPROOF REST FOR SPLUNK 9.x
    // Uses raw $.ajax with multiple CSRF extraction methods
    // ============================================================
    var _locale = window.location.pathname.split('/')[1] || 'en-US';

    function _csrf() {
        // Method 1: Cookie (most reliable on 9.x)
        var cks = document.cookie.split(';');
        for (var i = 0; i < cks.length; i++) {
            var c = cks[i].replace(/^\s+/, '');
            if (c.indexOf('splunkweb_csrf_token_') === 0) {
                var val = c.substring(c.indexOf('=') + 1);
                console.log('[AM] CSRF from cookie: ' + val.substring(0,8) + '...');
                return val;
            }
        }
        // Method 2: Hidden form field
        var $inp = $('input[name="splunk_form_key"]');
        if ($inp.length && $inp.val()) {
            console.log('[AM] CSRF from form field');
            return $inp.val();
        }
        // Method 3: Splunk global $C
        try {
            if (window.$C && window.$C.FORM_KEY) {
                console.log('[AM] CSRF from $C.FORM_KEY');
                return window.$C.FORM_KEY;
            }
        } catch(e) {}
        // Method 4: Legacy Splunk.util
        try {
            var fk = Splunk.util.getFormKey();
            if (fk) { console.log('[AM] CSRF from Splunk.util'); return fk; }
        } catch(e) {}
        console.error('[AM] *** NO CSRF TOKEN FOUND ***');
        return '';
    }

    var _csrfToken = _csrf();
    console.log('[AM] Locale: ' + _locale + ' | CSRF: ' + (_csrfToken ? 'OK (' + _csrfToken.substring(0,8) + '...)' : '*** MISSING ***'));

    function _rest(method, endpoint, params, cb) {
        // Refresh CSRF on each call in case it changed
        _csrfToken = _csrf();
        var url = '/' + _locale + '/splunkd/__raw' + endpoint;
        console.log('[AM] REST: ' + method + ' ' + url);

        var ajaxOpts = {
            url: url,
            type: method,
            headers: {
                'X-Splunk-Form-Key': _csrfToken,
                'X-Requested-With': 'XMLHttpRequest'
            },
            timeout: 30000
        };

        if (method === 'GET') {
            ajaxOpts.data = params || {};
        } else if (method === 'POST') {
            // POST: send as form data
            ajaxOpts.data = $.param(params || {});
            ajaxOpts.contentType = 'application/x-www-form-urlencoded; charset=UTF-8';
        } else if (method === 'DELETE') {
            // DELETE: no body, output_mode in URL
            if (url.indexOf('?') === -1) ajaxOpts.url += '?output_mode=json';
            else ajaxOpts.url += '&output_mode=json';
        }

        console.log('[AM] Headers: X-Splunk-Form-Key=' + (_csrfToken ? _csrfToken.substring(0,8)+'...' : 'NONE'));

        $.ajax(ajaxOpts)
        .done(function(data, textStatus, xhr) {
            console.log('[AM] ✓ ' + method + ' ' + endpoint + ' => HTTP ' + xhr.status);
            if (cb) cb(null, data);
        })
        .fail(function(xhr, textStatus, errorThrown) {
            console.error('[AM] ✗ ' + method + ' ' + endpoint + ' => HTTP ' + xhr.status + ' ' + textStatus);
            console.error('[AM] Response body: ' + (xhr.responseText || '').substring(0, 500));
            console.error('[AM] Error thrown: ' + errorThrown);
            var msg = 'HTTP ' + xhr.status + ': ' + (errorThrown || textStatus);
            // Try to parse error from response
            try {
                var j = JSON.parse(xhr.responseText);
                if (j.messages && j.messages[0]) msg = j.messages[0].text;
            } catch(e) {
                try {
                    var m = xhr.responseText.match(/<msg[^>]*>([^<]+)<\/msg>/);
                    if (m) msg = m[1];
                } catch(e2) {}
            }
            if (xhr.status === 0) msg = 'Network error or CORS blocked — check console Network tab';
            if (xhr.status === 401) msg = 'Not authenticated — please log in';
            if (xhr.status === 403) msg = 'Permission denied — CSRF token may be invalid';
            if (cb) cb({ status: xhr.status, message: msg });
        });
    }

    // ---- STATE ----
    var allAlerts = [], filteredAlerts = [], selectedAlerts = [];
    var currentPage = 1, pageSize = 20, currentAlertData = null;
    var pendingConfirmAction = null;

    // ---- CUSTOM CONFIRM (replaces native confirm() blocked in Splunk 9.x) ----
    function showConfirm(title, message, onYes) {
        $('#confirm-title').text(title);
        $('#confirm-message').text(message);
        pendingConfirmAction = onYes;
        $('#confirm-modal').fadeIn(200);
    }

    // ---- TOAST NOTIFICATIONS ----
    function showToast(msg, isError) {
        var bg = isError ? '#c62828' : '#2e7d32';
        var $t = $('<div style="position:fixed;top:20px;right:20px;z-index:20000;padding:12px 24px;background:'+bg+';color:#fff;border-radius:6px;font-size:14px;font-weight:500;box-shadow:0 4px 12px rgba(0,0,0,.3);max-width:450px;">'+msg+'</div>');
        $('body').append($t);
        setTimeout(function(){ $t.fadeOut(400, function(){ $t.remove(); }); }, 3500);
    }

    // ---- LOAD ALERTS ----
    function loadAlerts() {
        $('#alerts-tbody').html('<tr><td colspan="8" style="text-align:center;padding:40px;">Loading...</td></tr>');
        _rest('GET', '/servicesNS/-/-/saved/searches', { output_mode: 'json', count: 0, search: 'is_scheduled=1 OR alert_type=*' }, function(err, resp) {
            if (err) {
                $('#alerts-tbody').html('<tr><td colspan="8" style="text-align:center;padding:40px;color:red;">Error loading alerts: '+err.message+'</td></tr>');
                return;
            }
            allAlerts = [];
            var data;
            try { data = (typeof resp === 'string') ? JSON.parse(resp) : resp; } catch(e) {
                console.error('[AM] JSON parse error:', e);
                return;
            }
            (data.entry || []).forEach(function(entry) {
                var c = entry.content || {};
                if (c.is_scheduled === true || c.is_scheduled === '1' || (c.alert_type && c.alert_type !== '')) {
                    var type = ((c.alert_type && c.alert_type !== 'always') || (c.actions && c.actions !== '')) ? 'alert' : 'report';
                    // Extract REST path from entry.id (e.g. "https://host:8089/servicesNS/nobody/search/saved/searches/MyAlert")
                    var restPath = '';
                    if (entry.id) {
                        var idMatch = entry.id.match(/(\/servicesNS\/[^?]+)/);
                        if (idMatch) restPath = idMatch[1];
                    }
                    // Fallback: also check entry.links.edit
                    if (!restPath && entry.links && entry.links.edit) {
                        var linkMatch = entry.links.edit.match(/(\/servicesNS\/[^?]+)/);
                        if (linkMatch) restPath = linkMatch[1];
                    }
                    // Last resort: construct from acl
                    if (!restPath) {
                        var own = (entry.acl && entry.acl.sharing !== 'user') ? 'nobody' : (entry.acl ? entry.acl.owner : 'nobody');
                        var ap = entry.acl ? entry.acl.app : 'search';
                        restPath = '/servicesNS/' + encodeURIComponent(own) + '/' + encodeURIComponent(ap) + '/saved/searches/' + encodeURIComponent(entry.name);
                    }
                    console.log('[AM] Alert: ' + entry.name + ' => ' + restPath);
                    allAlerts.push({
                        name: entry.name, type: type,
                        disabled: c.disabled === true || c.disabled === '1',
                        owner: entry.acl ? entry.acl.owner : '-',
                        app: entry.acl ? entry.acl.app : '-',
                        sharing: entry.acl ? entry.acl.sharing : 'app',
                        restPath: restPath,
                        cron: c.cron_schedule || '-', search: c.search || '',
                        earliest: c['dispatch.earliest_time'] || '',
                        latest: c['dispatch.latest_time'] || '',
                        alert_type: c.alert_type || '',
                        alert_comparator: c.alert_comparator || '',
                        alert_threshold: c.alert_threshold || '',
                        actions: c.actions || '',
                        suppress: c['alert.suppress'] === '1' || c['alert.suppress'] === true,
                        suppress_period: c['alert.suppress.period'] || ''
                    });
                }
            });
            allAlerts.sort(function(a, b) { return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
            console.log('[AM] Loaded: ' + allAlerts.length + ' alerts/reports');
            updateStats();
            populateAppDropdown();
            applyFilters();
        });
    }

    function updateStats() {
        var en = allAlerts.filter(function(a) { return !a.disabled; }).length;
        $('#total-count').text(allAlerts.length);
        $('#enabled-count').text(en);
        $('#disabled-count').text(allAlerts.length - en);
    }

    function populateAppDropdown() {
        var apps = [];
        allAlerts.forEach(function(a) { if (a.app && apps.indexOf(a.app) === -1) apps.push(a.app); });
        apps.sort();
        var h = '<option value="all">All Apps</option>';
        apps.forEach(function(a) { h += '<option value="' + esc(a) + '">' + esc(a) + '</option>'; });
        $('#filter-app').html(h);
    }

    function applyFilters() {
        var st = ($('#search-input').val() || '').toLowerCase();
        var qt = ($('#search-query').val() || '').toLowerCase();
        var af = $('#filter-app').val() || 'all';
        var tf = $('#filter-type').val() || 'all';
        var sf = $('#filter-status').val() || 'all';
        filteredAlerts = allAlerts.filter(function(a) {
            if (st && a.name.toLowerCase().indexOf(st) === -1) return false;
            if (qt && a.search.toLowerCase().indexOf(qt) === -1) return false;
            if (af !== 'all' && a.app !== af) return false;
            if (tf !== 'all' && a.type !== tf) return false;
            if (sf === 'enabled' && a.disabled) return false;
            if (sf === 'disabled' && !a.disabled) return false;
            return true;
        });
        currentPage = 1;
        selectedAlerts = [];
        updateSelectAll();
        renderTable();
    }

    // ---- RENDER TABLE ----
    function renderTable() {
        var s = (currentPage - 1) * pageSize, e = s + pageSize;
        var page = filteredAlerts.slice(s, e);
        if (!page.length) {
            $('#alerts-tbody').html('<tr><td colspan="8" style="text-align:center;padding:40px;">No alerts found.</td></tr>');
            $('#showing-text').text('0 of 0');
            $('#btn-prev,#btn-next').prop('disabled', true);
            return;
        }
        var h = '';
        page.forEach(function(a) {
            var sel = selectedAlerts.indexOf(a.name) !== -1;
            var n = esc(a.name);
            h += '<tr class="alert-row' + (sel ? ' selected' : '') + '">';
            h += '<td><input type="checkbox" class="alert-checkbox" data-name="' + n + '"' + (sel ? ' checked' : '') + '/></td>';
            h += '<td class="alert-name-cell"><span class="alert-name" data-name="' + n + '">' + n + '</span></td>';
            h += '<td><span class="app-badge">' + esc(a.app) + '</span></td>';
            h += '<td><span class="type-badge type-' + a.type + '">' + cap(a.type) + '</span></td>';
            h += '<td><span class="status-badge ' + (a.disabled ? 'status-disabled' : 'status-enabled') + '">' + (a.disabled ? 'Disabled' : 'Enabled') + '</span></td>';
            h += '<td>' + esc(a.owner) + '</td>';
            h += '<td>' + esc(cronLabel(a.cron)) + '</td>';
            h += '<td class="actions-cell">';
            h += '<button class="btn btn-xs btn-primary btn-edit" data-name="' + n + '">Edit</button> ';
            if (a.disabled) {
                h += '<button class="btn btn-xs btn-success btn-enable" data-name="' + n + '">Enable</button> ';
            } else {
                h += '<button class="btn btn-xs btn-warning btn-disable" data-name="' + n + '">Disable</button> ';
            }
            h += '<button class="btn btn-xs btn-danger btn-delete" data-name="' + n + '">Delete</button>';
            h += '</td></tr>';
        });
        $('#alerts-tbody').html(h);
        var tp = Math.ceil(filteredAlerts.length / pageSize);
        $('#showing-text').text('Showing ' + (s + 1) + '-' + Math.min(e, filteredAlerts.length) + ' of ' + filteredAlerts.length);
        $('#page-info').text('Page ' + currentPage + ' of ' + tp);
        $('#btn-prev').prop('disabled', currentPage <= 1);
        $('#btn-next').prop('disabled', currentPage >= tp);
        updateBulk();
    }

    function esc(s) { return !s ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
    function cronLabel(c) {
        var m = { '*/1 * * * *': 'Every min', '*/5 * * * *': 'Every 5 min', '*/15 * * * *': 'Every 15 min', '*/30 * * * *': 'Every 30 min', '0 * * * *': 'Hourly', '0 */4 * * *': 'Every 4 hrs', '0 0 * * *': 'Daily', '0 0 * * 0': 'Weekly', '0 0 1 * *': 'Monthly' };
        return m[c] || c || '-';
    }
    function getPageNames() { var s = (currentPage - 1) * pageSize; return filteredAlerts.slice(s, s + pageSize).map(function(a) { return a.name; }); }
    function updateSelectAll() {
        var pn = getPageNames();
        if (!pn.length) { $('#select-all').prop('checked', false); return; }
        $('#select-all').prop('checked', pn.every(function(n) { return selectedAlerts.indexOf(n) !== -1; }));
    }
    function updateBulk() { $('#btn-bulk-enable,#btn-bulk-disable,#btn-bulk-delete').prop('disabled', !selectedAlerts.length); }

    // ---- DETAILS MODAL ----
    function showDetails(name) {
        var a = allAlerts.filter(function(x) { return x.name === name; })[0];
        if (!a) return;
        currentAlertData = a;
        $('#modal-title').text(a.type === 'alert' ? 'Alert Details' : 'Report Details');
        $('#detail-name').text(a.name);
        $('#detail-type').html('<span class="type-badge type-' + a.type + '">' + cap(a.type) + '</span>');
        $('#detail-status').html('<span class="status-badge ' + (a.disabled ? 'status-disabled' : 'status-enabled') + '">' + (a.disabled ? 'Disabled' : 'Enabled') + '</span>');
        $('#detail-owner').text(a.owner);
        $('#detail-app').text(a.app);
        $('#detail-cron').text(a.cron + (a.cron !== '-' ? ' (' + cronLabel(a.cron) + ')' : ''));
        $('#detail-timerange').text((a.earliest || '-') + ' to ' + (a.latest || 'now'));
        var tt = a.alert_type || 'always';
        if (a.alert_comparator && a.alert_threshold) tt += ' - ' + a.alert_comparator + ' ' + a.alert_threshold;
        $('#detail-trigger').text(tt);
        $('#detail-actions').text(a.actions || '-');
        $('#detail-throttle').text(a.suppress ? 'Yes (' + a.suppress_period + ')' : 'No');
        $('#detail-query').text(a.search);
        if (a.disabled) { $('#btn-modal-enable').show(); $('#btn-modal-disable').hide(); }
        else { $('#btn-modal-enable').hide(); $('#btn-modal-disable').show(); }
        $('#alert-modal').fadeIn(200);
    }

    // ---- ENABLE / DISABLE / DELETE ----
    // Uses the exact REST path from Splunk's entry.id — no URL guessing
    function getRestPath(name) {
        var a = allAlerts.filter(function(x) { return x.name === name; })[0];
        if (a && a.restPath) {
            console.log('[AM] restPath for "' + name + '": ' + a.restPath);
            return a.restPath;
        }
        console.warn('[AM] No restPath for "' + name + '", fallback to nobody/search');
        return '/servicesNS/nobody/search/saved/searches/' + encodeURIComponent(name);
    }

    function enableAlert(name, cb) {
        var path = getRestPath(name);
        console.log('[AM] >>> ENABLE: ' + name + ' via ' + path);
        showToast('Enabling: ' + name + '...', false);
        _rest('POST', path, { disabled: '0', output_mode: 'json' }, function(err) {
            if (err) {
                console.error('[AM] Enable FAIL:', err.message);
                showToast('Enable failed: ' + err.message, true);
                if (cb) cb(false);
            } else {
                console.log('[AM] ✓ Enabled: ' + name);
                showToast('✓ Enabled: ' + name, false);
                if (cb) cb(true);
            }
        });
    }

    function disableAlert(name, cb) {
        var path = getRestPath(name);
        console.log('[AM] >>> DISABLE: ' + name + ' via ' + path);
        showToast('Disabling: ' + name + '...', false);
        _rest('POST', path, { disabled: '1', output_mode: 'json' }, function(err) {
            if (err) {
                console.error('[AM] Disable FAIL:', err.message);
                showToast('Disable failed: ' + err.message, true);
                if (cb) cb(false);
            } else {
                console.log('[AM] ✓ Disabled: ' + name);
                showToast('✓ Disabled: ' + name, false);
                if (cb) cb(true);
            }
        });
    }

    function deleteAlert(name, cb) {
        var path = getRestPath(name);
        console.log('[AM] >>> DELETE: ' + name + ' via ' + path);
        showToast('Deleting: ' + name + '...', false);
        var locale = window.location.pathname.split('/')[1] || 'en-US';
        $.ajax({
            url: '/' + locale + '/splunkd/__raw' + path + '?output_mode=json',
            type: 'DELETE',
            headers: { 'X-Splunk-Form-Key': _csrf(), 'X-Requested-With': 'XMLHttpRequest' },
            success: function() {
                console.log('[AM] ✓ Deleted: ' + name);
                showToast('✓ Deleted: ' + name, false);
                if (cb) cb(true);
            },
            error: function(xhr) {
                console.error('[AM] DELETE FAIL (' + xhr.status + '):', (xhr.responseText || '').substring(0, 300));
                var msg = xhr.responseText || xhr.statusText || 'Unknown error';
                try { msg = JSON.parse(xhr.responseText).messages[0].text; } catch(e) {}
                if (msg.indexOf('cannot be deleted') !== -1 || msg.indexOf('config=') !== -1) {
                    showConfirm('Cannot Delete', '"' + name + '" is defined in a config file. Disable instead?', function() {
                        disableAlert(name, function(ok) { if (cb) cb(ok); });
                    });
                } else {
                    showToast('Delete failed: ' + msg.substring(0, 150), true);
                    if (cb) cb(false);
                }
            }
        });
    }

    // Bulk: run operations one at a time (sequential) to avoid race conditions
    function bulkOp(fn) {
        if (!selectedAlerts.length) { showToast('No alerts selected', true); return; }
        var list = selectedAlerts.slice();
        var total = list.length, done = 0, failed = 0;
        showToast('Processing ' + total + ' alerts...', false);
        function next() {
            if (list.length === 0) {
                selectedAlerts = [];
                showToast('✓ Completed: ' + done + ' succeeded' + (failed > 0 ? ', ' + failed + ' failed' : ''), failed > 0);
                loadAlerts();
                return;
            }
            var n = list.shift();
            fn(n, function(ok) {
                if (ok) done++; else failed++;
                next();
            });
        }
        next();
    }

    // ---- EVENTS ----
    var sTo;
    $(document).on('input', '#search-input,#search-query', function() { clearTimeout(sTo); sTo = setTimeout(applyFilters, 300); });
    $(document).on('change', '#filter-app,#filter-type,#filter-status', applyFilters);
    $(document).on('click', '#btn-refresh', loadAlerts);

    // Select all / checkbox
    $(document).on('change', '#select-all', function() {
        var chk = $(this).is(':checked');
        getPageNames().forEach(function(n) {
            var i = selectedAlerts.indexOf(n);
            if (chk && i === -1) selectedAlerts.push(n);
            else if (!chk && i !== -1) selectedAlerts.splice(i, 1);
        });
        renderTable();
    });
    $(document).on('change', '.alert-checkbox', function() {
        var n = $(this).data('name'), chk = $(this).is(':checked');
        var i = selectedAlerts.indexOf(n);
        if (chk && i === -1) selectedAlerts.push(n);
        else if (!chk && i !== -1) selectedAlerts.splice(i, 1);
        updateSelectAll(); updateBulk();
        $(this).closest('tr').toggleClass('selected', chk);
    });

    // Click alert name -> details
    $(document).on('click', '.alert-name', function() { showDetails($(this).data('name')); });

    // Edit button
    $(document).on('click', '.btn-edit', function(e) {
        e.stopPropagation();
        var name = $(this).data('name');
        console.log('[AM] Edit clicked: ' + name);
        window.open('/' + _locale + '/app/alerting_framework/alerting_framework?alert=' + encodeURIComponent(name), '_blank');
    });

    // Enable button (no confirmation needed)
    $(document).on('click', '.btn-enable', function(e) {
        e.stopPropagation();
        var n = $(this).data('name');
        var $btn = $(this);
        console.log('[AM] Enable clicked: ' + n);
        $btn.prop('disabled', true).text('...');
        enableAlert(n, function(ok) {
            if (ok) loadAlerts();
            else $btn.prop('disabled', false).text('Enable');
        });
    });

    // Disable button (custom confirm)
    $(document).on('click', '.btn-disable', function(e) {
        e.stopPropagation();
        var n = $(this).data('name');
        console.log('[AM] Disable clicked: ' + n);
        showConfirm('Disable Alert', 'Disable "' + n + '"?', function() {
            disableAlert(n, function(ok) { if (ok) loadAlerts(); });
        });
    });

    // Delete button (custom confirm)
    $(document).on('click', '.btn-delete', function(e) {
        e.stopPropagation();
        var n = $(this).data('name');
        console.log('[AM] Delete clicked: ' + n);
        showConfirm('Delete Alert', 'Permanently delete "' + n + '"? This cannot be undone.', function() {
            deleteAlert(n, function(ok) { if (ok) loadAlerts(); });
        });
    });

    // Bulk operations
    $(document).on('click', '#btn-bulk-enable', function() {
        showConfirm('Bulk Enable', 'Enable ' + selectedAlerts.length + ' selected?', function() { bulkOp(enableAlert); });
    });
    $(document).on('click', '#btn-bulk-disable', function() {
        showConfirm('Bulk Disable', 'Disable ' + selectedAlerts.length + ' selected?', function() { bulkOp(disableAlert); });
    });
    $(document).on('click', '#btn-bulk-delete', function() {
        showConfirm('Bulk Delete', 'DELETE ' + selectedAlerts.length + ' selected? Cannot undo.', function() { bulkOp(deleteAlert); });
    });

    // Confirm modal
    $(document).on('click', '#btn-confirm-yes', function() {
        $('#confirm-modal').fadeOut(200);
        if (pendingConfirmAction) {
            var fn = pendingConfirmAction;
            pendingConfirmAction = null;
            fn();
        }
    });
    $(document).on('click', '#confirm-close,#btn-confirm-no', function() {
        $('#confirm-modal').fadeOut(200);
        pendingConfirmAction = null;
    });

    // Pagination
    $(document).on('click', '#btn-prev', function() { if (currentPage > 1) { currentPage--; renderTable(); } });
    $(document).on('click', '#btn-next', function() {
        if (currentPage < Math.ceil(filteredAlerts.length / pageSize)) { currentPage++; renderTable(); }
    });

    // Details modal
    $(document).on('click', '#modal-close,#btn-modal-close', function() { $('#alert-modal').fadeOut(200); currentAlertData = null; });
    $(document).on('click', '#alert-modal', function(e) {
        if ($(e.target).hasClass('modal-overlay')) { $('#alert-modal').fadeOut(200); currentAlertData = null; }
    });
    $(document).on('click', '#btn-modal-edit', function() {
        if (currentAlertData) window.open('/' + _locale + '/app/alerting_framework/alerting_framework?alert=' + encodeURIComponent(currentAlertData.name), '_blank');
    });
    $(document).on('click', '#btn-modal-enable', function() {
        if (!currentAlertData) return;
        enableAlert(currentAlertData.name, function(ok) { if (ok) { $('#alert-modal').fadeOut(200); loadAlerts(); } });
    });
    $(document).on('click', '#btn-modal-disable', function() {
        if (!currentAlertData) return;
        disableAlert(currentAlertData.name, function(ok) { if (ok) { $('#alert-modal').fadeOut(200); loadAlerts(); } });
    });
    $(document).on('click', '#btn-modal-delete', function() {
        if (!currentAlertData) return;
        var n = currentAlertData.name;
        showConfirm('Delete Alert', 'Permanently delete "' + n + '"?', function() {
            deleteAlert(n, function(ok) { if (ok) { $('#alert-modal').fadeOut(200); loadAlerts(); } });
        });
    });

    // ---- INIT ----
    console.log('[AM] Init complete. Loading alerts...');
    loadAlerts();
});
