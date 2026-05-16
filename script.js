// ═══════════════════════════════════════════════════════════════════
//  LOGIN GATE
// ═══════════════════════════════════════════════════════════════════
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin@123';

(function initLoginGate() {
    const gate = document.getElementById('login-gate');

    // Already logged in this session → hide gate immediately
    if (sessionStorage.getItem('pd_auth') === '1') {
        gate.style.display = 'none';
        return;
    }

    // Block the dashboard from being visible until auth passes
    gate.style.display = 'flex';

    // Password eye toggle
    document.getElementById('toggle-password').addEventListener('click', () => {
        const pwInput = document.getElementById('login-password');
        const icon = document.getElementById('pw-eye-icon');
        const isHidden = pwInput.type === 'password';
        pwInput.type = isHidden ? 'text' : 'password';
        icon.className = isHidden ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
    });

    // Form submit
    document.getElementById('login-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const user = document.getElementById('login-username').value.trim();
        const pass = document.getElementById('login-password').value;
        const errEl = document.getElementById('login-error');

        if (user === ADMIN_USER && pass === ADMIN_PASS) {
            // ✅ Correct — animate out and unlock dashboard
            sessionStorage.setItem('pd_auth', '1');
            gate.classList.add('login-gate--fade-out');
            gate.addEventListener('animationend', () => {
                gate.style.display = 'none';
                gate.classList.remove('login-gate--fade-out');
            }, { once: true });
        } else {
            // ❌ Wrong — shake the card and show error
            errEl.style.display = 'flex';
            const card = gate.querySelector('.login-card');
            card.classList.remove('shake');
            void card.offsetWidth; // reflow to restart animation
            card.classList.add('shake');
        }
    });
})();

// ═══════════════════════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

// Main Google Sheet API (reads all leads)
const API_URL = 'https://script.google.com/macros/s/AKfycbwAZ5fuUTDqyUKMmpOMTJRNegrKZA231-qbkX6cAcCph6aa6Asw-C2ogMoKsN478k8Q/exec';

// Closed Queries Google Sheet API
// After deploying closed_queries_appscript.js as a Web App, paste the URL below:
const CLOSED_QUERIES_API_URL = 'https://script.google.com/macros/s/AKfycbwUP7dJaji6MevQzq4K0uyMfwI5FVLsUQNuMXbe-Frzl55I3Kjj-vmtkjtGyfg45iI4WQ/exec';

// Rejected Payments Google Sheet API
// After deploying rejected_payments_appscript.js as a Web App, paste the URL below:
const REJECTED_PAYMENTS_API_URL = 'https://script.google.com/macros/s/AKfycby-WGnQ8ntbQxJMzgzZSVAFbSBFbdPpFa3Fnp0hHSrMvJxiwrgM2f9kqbMzCmKo_cgDzw/exec';


// ═══════════════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════════════
let sheetData = [];
let sheetHeaders = [];
let filteredData = [];
let closedQueries = new Set(); // Transaction IDs of closed entries
let closedQueriesDetails = {};       // txnId → { txnId, email, phone, date, closedOn }
let queriesResolved = 0;
let rejectedPayments = new Set(); // Transaction IDs of rejected entries
let rejectedPaymentsDetails = {};    // txnId → detail object

// ── Pagination ────────────────────────────────────────────────────
const ROWS_PER_PAGE = 10;
let currentPage = 1;

// ── Status Filter (all | open | closed) ───────────────────────────
let statusFilter = 'all';

// ═══════════════════════════════════════════════════════════════════
//  CLOSED-ENTRY LOOKUP HELPER
//
//  THREE-LEVEL match (most specific → least specific):
//  Level 1: email + phone + date  (exact)
//  Level 2: email + phone         (immune to date-format / timezone drift)
//  Level 3: email only            (#ERROR! phone in closed sheet → this catches it)
// ═══════════════════════════════════════════════════════════════════
function isEntryClosed(txnId) {
    if (!txnId) return false;
    return closedQueries.has(txnId);
}

// ═══════════════════════════════════════════════════════════════════
//  DOM ELEMENTS
// ═══════════════════════════════════════════════════════════════════
const tableBody = document.querySelector('#data-table tbody');
const refreshBtn = document.getElementById('refresh-btn');
const modal = document.getElementById('edit-modal');
const closeModalSpan = document.querySelector('.close-modal');
const searchInput = document.getElementById('search-input');
const queryModal = document.getElementById('query-modal');
const closeQueryModalSpan = document.querySelector('.close-query-modal');

// Chart instances
let pieChart, barChart, histogramChart;

// ═══════════════════════════════════════════════════════════════════
//  INITIAL LOAD
// ═══════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
    // Load localStorage instantly so badge & stats are populated before the
    // network call finishes; fetchData() will re-sync from the Sheet and
    // re-render the table with closed entries correctly filtered.
    loadClosedQueriesFromStorage();
    updateClosedBadge();
    fetchData();   // ← syncs from closed-queries Sheet internally before rendering
    initNavigation();
    initCharts();

    document.getElementById('back-btn').addEventListener('click', () => {
        document.getElementById('page-loader').style.display = 'flex';
        setTimeout(() => {
            document.getElementById('query-section').style.display = 'none';
            document.getElementById('dashboard-section').style.display = 'block';
            document.getElementById('page-loader').style.display = 'none';
        }, 2000);
    });

    document.getElementById('close-all-btn').addEventListener('click', closeAllQueries);

    // ── Status filter pills ──────────────────────────────────────
    document.getElementById('status-filter-group').addEventListener('click', (e) => {
        const btn = e.target.closest('.filter-pill');
        if (!btn) return;
        // Update active pill
        document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('filter-pill--active'));
        btn.classList.add('filter-pill--active');
        // Apply filter and reset to page 1
        statusFilter = btn.dataset.filter;
        currentPage = 1;
        renderTable();
    });

    // ── User avatar dropdown ──────────────────────────────────────
    const userAvatar = document.getElementById('user-avatar');
    const userDropdown = document.getElementById('user-dropdown');
    const logoutBtn = document.getElementById('logout-btn');

    userAvatar.addEventListener('click', (e) => {
        e.stopPropagation();
        userDropdown.classList.toggle('show');
    });

    document.addEventListener('click', () => {
        userDropdown.classList.remove('show');
    });

    logoutBtn.addEventListener('click', () => {
        sessionStorage.removeItem('pd_auth');
        location.reload();
    });
});

// ═══════════════════════════════════════════════════════════════════
//  LOCAL STORAGE — persistence across page reloads
// ═══════════════════════════════════════════════════════════════════
function loadClosedQueriesFromStorage() {
    const savedKeys = localStorage.getItem('closedQueries');
    if (savedKeys) {
        closedQueries = new Set(JSON.parse(savedKeys));
        queriesResolved = closedQueries.size;
    }
    const savedDetails = localStorage.getItem('closedQueriesDetails');
    if (savedDetails) {
        closedQueriesDetails = JSON.parse(savedDetails);
    }
    const savedRejected = localStorage.getItem('rejectedPayments');
    if (savedRejected) {
        rejectedPayments = new Set(JSON.parse(savedRejected));
    }
    const savedRejectedDetails = localStorage.getItem('rejectedPaymentsDetails');
    if (savedRejectedDetails) {
        rejectedPaymentsDetails = JSON.parse(savedRejectedDetails);
    }
}

function saveClosedQueriesToStorage() {
    localStorage.setItem('closedQueries', JSON.stringify([...closedQueries]));
    localStorage.setItem('closedQueriesDetails', JSON.stringify(closedQueriesDetails));
}

function saveRejectedPaymentsToStorage() {
    localStorage.setItem('rejectedPayments', JSON.stringify([...rejectedPayments]));
    localStorage.setItem('rejectedPaymentsDetails', JSON.stringify(rejectedPaymentsDetails));
}

// ═══════════════════════════════════════════════════════════════════
//  GOOGLE SHEET — push a rejected payment row
// ═══════════════════════════════════════════════════════════════════
function postRejectedPaymentToSheet(detail) {
    try {
        const params = new URLSearchParams({
            transactionId: detail.txnId,
            date: detail.date,
            fullName: detail.fullName,
            email: detail.email,
            phone: detail.phone,
            service: detail.service,
            package: detail.pkg,
            amount: detail.amount,
            rejectedOn: detail.rejectedOn,
            action: 'reject'
        });
        const url = `${REJECTED_PAYMENTS_API_URL}?${params.toString()}`;
        const img = new Image();
        img.src = url;
        console.log('Rejected payment GET fired:', url);
    } catch (err) {
        console.error('Failed to push rejected payment:', err);
    }
}

// ═══════════════════════════════════════════════════════════════════
//  GOOGLE SHEET — push a closed query row
// ═══════════════════════════════════════════════════════════════════
function postClosedQueryToSheet(detail) {
    try {
        const params = new URLSearchParams({
            transactionId: detail.txnId,
            date: detail.date,
            fullName: detail.fullName,
            email: detail.email,
            phone: detail.phone,
            service: detail.service,
            package: detail.pkg,
            amount: detail.amount,
            closedOn: detail.closedOn,
            sendEmail: 'true',
            action: 'close'
        });
        const url = `${CLOSED_QUERIES_API_URL}?${params.toString()}`;
        // Use an img tag trick — fires a GET request, no CORS issues, works from file://
        const img = new Image();
        img.src = url;
        console.log('Closed query GET fired:', url);
    } catch (err) {
        console.error('Failed to push closed query:', err);
    }
}

// ═══════════════════════════════════════════════════════════════════
//  GOOGLE SHEET — sync closed queries (SOURCE OF TRUTH)
//
//  This function is called on EVERY page load, refresh, and manual
//  Refresh button click.  It rebuilds closedQueries + closedEmailPhoneSet
//  from scratch using the closed-queries Google Sheet as the single source
//  of truth.  localStorage is used only as an instant pre-fill while the
//  network request is in-flight.
// ═══════════════════════════════════════════════════════════════════
async function syncClosedQueriesFromSheet() {
    const sheetRows = await fetchClosedQueriesFromSheet();
    if (sheetRows && sheetRows.length > 0) {
        closedQueries = new Set();
        closedQueriesDetails = {};
        sheetRows.forEach(row => {
            const txnId = String(row['Transaction ID'] || '').trim();
            if (!txnId) return;
            closedQueries.add(txnId);
            closedQueriesDetails[txnId] = {
                txnId,
                date: row['Date'] || '',
                fullName: row['Full Name'] || '',
                email: row['Email'] || '',
                phone: row['Phone'] || '',
                service: row['Service'] || '',
                pkg: row['Package'] || '',
                amount: row['Amount'] || '',
                closedOn: row['Closed On'] || ''
            };
        });
        queriesResolved = closedQueries.size;
        saveClosedQueriesToStorage();
        console.log(`[sync] ✔ ${closedQueries.size} closed transaction(s) loaded from Google Sheet.`);
    } else {
        console.warn('[sync] ⚠️ No data from sheet — using localStorage fallback.');
    }
}

async function syncRejectedPaymentsFromSheet() {
    if (REJECTED_PAYMENTS_API_URL === 'YOUR_REJECTED_PAYMENTS_WEB_APP_URL_HERE') return;
    try {
        const res = await fetch(`${REJECTED_PAYMENTS_API_URL}?t=${Date.now()}`);
        const json = await res.json();
        if (json.success && Array.isArray(json.data) && json.data.length > 0) {
            rejectedPayments = new Set();
            rejectedPaymentsDetails = {};
            json.data.forEach(row => {
                const txnId = String(row['Transaction ID'] || '').trim();
                if (!txnId) return;
                rejectedPayments.add(txnId);
                rejectedPaymentsDetails[txnId] = {
                    txnId,
                    date: row['Date'] || '',
                    fullName: row['Full Name'] || '',
                    email: row['Email'] || '',
                    phone: row['Phone'] || '',
                    service: row['Service'] || '',
                    pkg: row['Package'] || '',
                    amount: row['Amount'] || '',
                    rejectedOn: row['Rejected On'] || ''
                };
            });
            saveRejectedPaymentsToStorage();
            console.log(`[sync] ✔ ${rejectedPayments.size} rejected payment(s) loaded from Google Sheet.`);
        }
    } catch (err) {
        console.error('[sync] Failed to fetch rejected payments:', err);
    }
}

async function fetchClosedQueriesFromSheet() {
    if (CLOSED_QUERIES_API_URL === 'YOUR_CLOSED_QUERIES_WEB_APP_URL_HERE') {
        return null;
    }
    try {
        // Add a cache-busting timestamp so browsers/CDNs never serve a stale response
        const res = await fetch(`${CLOSED_QUERIES_API_URL}?t=${Date.now()}`);
        const json = await res.json();
        if (json.success && Array.isArray(json.data)) {
            return json.data; // [{ Date, Email, Phone, Messages, 'Closed On', Status }]
        }
    } catch (err) {
        console.error('[sync] Failed to fetch closed queries from Google Sheet:', err);
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════════════════════════════
function initNavigation() {
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
            link.classList.add('active');

            const section = link.dataset.section;
            document.querySelectorAll('.content-section').forEach(s => s.style.display = 'none');

            if (section === 'analytics') {
                document.getElementById('analytics-section').style.display = 'block';
                updateCharts();
            } else if (section === 'dashboard') {
                document.getElementById('dashboard-section').style.display = 'block';
            } else if (section === 'closed-queries') {
                document.getElementById('closed-queries-section').style.display = 'block';
                renderClosedQueriesSection();
            } else if (section === 'rejected-payments') {
                document.getElementById('rejected-payments-section').style.display = 'block';
                renderRejectedPaymentsSection();
            }
        });
    });
}

// ═══════════════════════════════════════════════════════════════════
//  SEARCH
// ═══════════════════════════════════════════════════════════════════
searchInput.addEventListener('input', (e) => {
    const term = e.target.value.toLowerCase();
    filteredData = term
        ? sheetData.filter(row => {
            return (
                (row['Full Name'] || '').toLowerCase().includes(term) ||
                (row.Email || '').toLowerCase().includes(term) ||
                (row.Phone || '').toLowerCase().includes(term) ||
                (String(row['Transaction ID'] || '')).toLowerCase().includes(term)
            );
        })
        : sheetData;
    currentPage = 1;
    renderTable();
});

// ═══════════════════════════════════════════════════════════════════
//  MODAL CLOSE HANDLERS
// ═══════════════════════════════════════════════════════════════════
refreshBtn.addEventListener('click', fetchData);

closeModalSpan.onclick = () => { modal.style.display = 'none'; };
closeQueryModalSpan.onclick = () => { queryModal.style.display = 'none'; };
window.onclick = (event) => {
    if (event.target === modal) modal.style.display = 'none';
    if (event.target === queryModal) queryModal.style.display = 'none';
};

// ═══════════════════════════════════════════════════════════════════
//  FETCH LEADS DATA
// ═══════════════════════════════════════════════════════════════════
async function fetchData() {
    if (API_URL === 'YOUR_WEB_APP_URL_HERE') {
        mockData();
        return;
    }
    try {
        refreshBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';

        // ── Fetch BOTH sheets in parallel for speed ─────────────────
        // syncClosedQueriesFromSheet() rebuilds the closed-set from the
        // Google Sheet (source of truth) BEFORE we render anything, so
        // every page open / refresh always shows only open entries.
        const [data] = await Promise.all([
            fetch(`${API_URL}?t=${Date.now()}`).then(r => r.json()),
            syncClosedQueriesFromSheet(),
            syncRejectedPaymentsFromSheet()
        ]);

        updateClosedBadge();

        sheetData = data;
        filteredData = data;

        if (data.length > 0) {
            sheetHeaders = ['Timestamp', 'Full Name', 'Email', 'Phone', 'Service', 'Package', 'Amount', 'Transaction ID'];
            renderTable();
            updateStats();
            updateCharts();
        }
    } catch (error) {
        console.error('Error fetching data:', error);
        alert('Failed to load data. Ensure "doGet" is implemented in your Apps Script.');
    } finally {
        refreshBtn.innerHTML = '<i class="fa-solid fa-rotate-right"></i> Refresh';
    }
}

// Mock Data (fallback)
function mockData() {
    sheetHeaders = ['Timestamp', 'Full Name', 'Email', 'Phone', 'Service', 'Package', 'Amount', 'Transaction ID'];
    sheetData = [
        { Timestamp: '2023-10-27T10:00:00.000Z', 'Full Name': 'John Doe', Email: 'john@example.com', Phone: '1234567890', Service: 'Prop Trading', Package: 'Basic', Amount: '5000', 'Transaction ID': 'TXN001' },
        { Timestamp: '2023-10-26T14:30:00.000Z', 'Full Name': 'Jane Smith', Email: 'jane@test.com', Phone: '9876543210', Service: 'Funded Account', Package: 'Pro', Amount: '10000', 'Transaction ID': 'TXN002' }
    ];
    filteredData = sheetData;
    renderTable();
    updateStats();
}

// ═══════════════════════════════════════════════════════════════════
//  RENDER MAIN TABLE
// ═══════════════════════════════════════════════════════════════════
function renderTable() {
    tableBody.innerHTML = '';
    const dataToRender = (filteredData.length > 0 || searchInput.value) ? filteredData : sheetData;

    let rows = dataToRender.map(row => ({
        date: row.Timestamp ? new Date(row.Timestamp).toLocaleDateString() : '',
        fullName: row['Full Name'] || '',
        email: row.Email || '',
        phone: row.Phone || '',
        service: row.Service || '',
        pkg: row.Package || '',
        amount: row.Amount || '',
        paymentMode: row['Payment Mode'] || row['payment mode'] || row['Payment mode'] || '',
        txnId: String(row['Transaction ID'] || '')
    })).sort((a, b) => new Date(b.date) - new Date(a.date));

    if (statusFilter === 'closed') {
        rows = rows.filter(r => isEntryClosed(r.txnId));
    } else {
        rows = rows.filter(r => !isEntryClosed(r.txnId) && !rejectedPayments.has(r.txnId));
    }

    const totalPages = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
    if (currentPage > totalPages) currentPage = totalPages;
    const pageRows = rows.slice((currentPage - 1) * ROWS_PER_PAGE, currentPage * ROWS_PER_PAGE);

    pageRows.forEach(row => {
        const isClosed = isEntryClosed(row.txnId);
        const tr = document.createElement('tr');

        [row.date, row.fullName, row.email, row.phone, row.service, row.pkg, row.amount, row.paymentMode, row.txnId].forEach(val => {
            const td = document.createElement('td');
            td.textContent = val;
            tr.appendChild(td);
        });

        const tdStatus = document.createElement('td');
        tdStatus.textContent = isClosed ? 'Closed' : 'Open';
        tdStatus.style.color = isClosed ? '#d4a843' : '#f59e0b';
        tdStatus.style.fontWeight = '600';
        tr.appendChild(tdStatus);

        const tdAction = document.createElement('td');
        tdAction.style.display = 'flex';
        tdAction.style.gap = '6px';

        const closeBtn = document.createElement('button');
        if (isClosed) {
            closeBtn.className = 'btn-close-query btn-close-query--closed';
            closeBtn.innerHTML = '<i class="fa-solid fa-check-circle"></i> Payment Approved';
            closeBtn.disabled = true;
        } else {
            closeBtn.className = 'btn-close-query';
            closeBtn.innerHTML = '<i class="fa-solid fa-check-circle"></i> Approve';
            closeBtn.onclick = () => closeQuery(row.txnId, row);
        }
        tdAction.appendChild(closeBtn);

        const rejectBtn = document.createElement('button');
        rejectBtn.className = 'btn-reject-payment';
        rejectBtn.innerHTML = '<i class="fa-solid fa-ban"></i> Reject';
        rejectBtn.onclick = () => rejectPayment(row.txnId, row);
        tdAction.appendChild(rejectBtn);

        tr.appendChild(tdAction);

        tableBody.appendChild(tr);
    });

    renderPagination(totalPages, rows.length);
}

// ═══════════════════════════════════════════════════════════════════
//  PAGINATION BAR
// ═══════════════════════════════════════════════════════════════════
function renderPagination(totalPages, totalEntries) {
    // Remove any existing pagination bar
    const existing = document.getElementById('pagination-bar');
    if (existing) existing.remove();

    if (totalPages <= 1) return;   // No need for pagination

    const bar = document.createElement('div');
    bar.id = 'pagination-bar';
    bar.className = 'pagination-bar';

    // Info label  e.g. "Showing 1–10 of 15 entries"
    const startEntry = (currentPage - 1) * ROWS_PER_PAGE + 1;
    const endEntry = Math.min(currentPage * ROWS_PER_PAGE, totalEntries);
    const info = document.createElement('span');
    info.className = 'pagination-info';
    info.textContent = `Showing ${startEntry}–${endEntry} of ${totalEntries} entries`;
    bar.appendChild(info);

    const controls = document.createElement('div');
    controls.className = 'pagination-controls';

    // Prev button
    const prevBtn = document.createElement('button');
    prevBtn.className = 'page-btn' + (currentPage === 1 ? ' page-btn--disabled' : '');
    prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
    prevBtn.disabled = currentPage === 1;
    prevBtn.onclick = () => { currentPage--; renderTable(); };
    controls.appendChild(prevBtn);

    // Page number pills (show max 5 around current page)
    const range = buildPageRange(currentPage, totalPages);
    range.forEach(p => {
        if (p === '...') {
            const dots = document.createElement('span');
            dots.className = 'page-dots';
            dots.textContent = '…';
            controls.appendChild(dots);
        } else {
            const btn = document.createElement('button');
            btn.className = 'page-btn' + (p === currentPage ? ' page-btn--active' : '');
            btn.textContent = p;
            btn.onclick = () => { currentPage = p; renderTable(); };
            controls.appendChild(btn);
        }
    });

    // Next button
    const nextBtn = document.createElement('button');
    nextBtn.className = 'page-btn' + (currentPage === totalPages ? ' page-btn--disabled' : '');
    nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
    nextBtn.disabled = currentPage === totalPages;
    nextBtn.onclick = () => { currentPage++; renderTable(); };
    controls.appendChild(nextBtn);

    bar.appendChild(controls);

    // Insert bar below the table-responsive div
    const tableSection = document.querySelector('#data-table').closest('.data-table-section');
    tableSection.appendChild(bar);
}

/** Returns an array like [1, '...', 4, 5, 6, '...', 12] */
function buildPageRange(current, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages = [];
    pages.push(1);
    if (current > 3) pages.push('...');
    for (let p = Math.max(2, current - 1); p <= Math.min(total - 1, current + 1); p++) {
        pages.push(p);
    }
    if (current < total - 2) pages.push('...');
    pages.push(total);
    return pages;
}

// ═══════════════════════════════════════════════════════════════════
//  QUERY VIEW (full-page query list)
// ═══════════════════════════════════════════════════════════════════
let currentQueryRowKey = '';

function showAllQueries(messages, rowKey) {
    currentQueryRowKey = rowKey;
    document.getElementById('page-loader').style.display = 'flex';
    setTimeout(() => {
        const queryListContent = document.getElementById('query-list-content');
        queryListContent.innerHTML = '';

        for (let i = 0; i < Math.min(5, messages.length); i++) {
            const queryItem = document.createElement('div');
            queryItem.className = 'query-item';

            const queryText = document.createElement('div');
            queryText.className = 'query-text';
            queryText.innerHTML = `<strong>Query ${i + 1}:</strong> ${messages[i]}`;

            queryItem.appendChild(queryText);
            queryListContent.appendChild(queryItem);
        }

        document.getElementById('dashboard-section').style.display = 'none';
        document.getElementById('analytics-section').style.display = 'none';
        document.getElementById('query-section').style.display = 'block';
        document.getElementById('page-loader').style.display = 'none';
    }, 2000);
}

// ═══════════════════════════════════════════════════════════════════
//  CLOSE QUERY ACTIONS
// ═══════════════════════════════════════════════════════════════════

/** Called from "Close All Queries" button inside the query view page */
function closeAllQueries() {
    const grouped = getGroupedData();
    const entry = grouped[currentQueryRowKey];
    const detail = {
        txnId: currentQueryRowKey,
        date: entry ? entry.date : '',
        fullName: entry ? entry.fullName : '',
        email: entry ? entry.email : '',
        phone: entry ? entry.phone : '',
        service: entry ? entry.service : '',
        pkg: entry ? entry.pkg : '',
        amount: entry ? entry.amount : '',
        closedOn: new Date().toLocaleString()
    };
    closedQueriesDetails[currentQueryRowKey] = detail;
    closedQueries.add(currentQueryRowKey);
    queriesResolved++;
    saveClosedQueriesToStorage();
    postClosedQueryToSheet(detail);
    updateStats();
    updateClosedBadge();
    document.getElementById('page-loader').style.display = 'flex';
    setTimeout(() => {
        document.getElementById('query-section').style.display = 'none';
        document.getElementById('dashboard-section').style.display = 'block';
        document.getElementById('page-loader').style.display = 'none';
        renderTable();
        updateCharts();
    }, 2000);
}

/** Called from "Reject Payment" button in the main table */
function rejectPayment(txnId, row) {
    const detail = {
        txnId,
        date: row.date,
        fullName: row.fullName,
        email: row.email,
        phone: row.phone,
        service: row.service,
        pkg: row.pkg,
        amount: row.amount,
        rejectedOn: new Date().toLocaleString()
    };
    rejectedPaymentsDetails[txnId] = detail;
    rejectedPayments.add(txnId);
    saveRejectedPaymentsToStorage();
    postRejectedPaymentToSheet(detail);
    updateStats();
    renderTable();
    updateCharts();
}

/** Called from "Accept" (Close Query) button in the main table */
function closeQuery(txnId, row) {
    const detail = {
        txnId,
        date: row.date,
        fullName: row.fullName,
        email: row.email,
        phone: row.phone,
        service: row.service,
        pkg: row.pkg,
        amount: row.amount,
        closedOn: new Date().toLocaleString()
    };
    closedQueriesDetails[txnId] = detail;
    closedQueries.add(txnId);
    queriesResolved++;
    saveClosedQueriesToStorage();
    postClosedQueryToSheet(detail);
    updateStats();
    updateClosedBadge();
    renderTable();
    updateCharts();
}

// ═══════════════════════════════════════════════════════════════════
//  CLOSED QUERIES SECTION — render in sidebar panel
// ═══════════════════════════════════════════════════════════════════
async function renderRejectedPaymentsSection() {
    const tbody = document.getElementById('rejected-payments-tbody');
    tbody.innerHTML = `
        <tr>
            <td colspan="8" style="text-align:center;padding:30px;color:var(--text-secondary);">
                <i class="fa-solid fa-spinner fa-spin" style="font-size:1.5rem;"></i><br>Loading rejected payments...
            </td>
        </tr>`;

    let rows = null;
    if (REJECTED_PAYMENTS_API_URL !== 'YOUR_REJECTED_PAYMENTS_WEB_APP_URL_HERE') {
        try {
            const res = await fetch(`${REJECTED_PAYMENTS_API_URL}?t=${Date.now()}`);
            const json = await res.json();
            if (json.success && Array.isArray(json.data)) rows = json.data;
        } catch (e) { console.error(e); }
    }

    tbody.innerHTML = '';
    if (rows && rows.length > 0) {
        rows.forEach(row => renderRejectedRow(tbody, {
            txnId: String(row['Transaction ID'] || ''),
            date: row['Date'] || '',
            fullName: row['Full Name'] || '',
            email: row['Email'] || '',
            phone: row['Phone'] || '',
            amount: row['Amount'] || '',
            rejectedOn: row['Rejected On'] || ''
        }));
    } else if (rejectedPayments.size > 0) {
        [...rejectedPayments].forEach(key => {
            const d = rejectedPaymentsDetails[key] || {};
            renderRejectedRow(tbody, {
                txnId: d.txnId || key, date: d.date || '', fullName: d.fullName || '',
                email: d.email || '', phone: d.phone || '', amount: d.amount || '', rejectedOn: d.rejectedOn || ''
            });
        });
    } else {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 8;
        td.style.cssText = 'text-align:center;color:var(--text-secondary);padding:50px;';
        td.innerHTML = '<i class="fa-solid fa-inbox" style="font-size:2.5rem;display:block;margin-bottom:12px;opacity:0.5;"></i>No rejected payments yet.';
        tr.appendChild(td);
        tbody.appendChild(tr);
    }
}

function renderRejectedRow(tbody, { txnId, date, fullName, email, phone, amount, rejectedOn }) {
    const tr = document.createElement('tr');
    const cells = [
        txnId, date, fullName, email, phone, amount, rejectedOn,
        '<span class="status-rejected-badge"><i class="fa-solid fa-ban"></i> Rejected</span>'
    ];
    cells.forEach((content, i) => {
        const td = document.createElement('td');
        if (i === 7) td.innerHTML = content;
        else td.textContent = content;
        tr.appendChild(td);
    });
    tbody.appendChild(tr);
}

async function renderClosedQueriesSection() {
    const tbody = document.getElementById('closed-queries-tbody');
    tbody.innerHTML = `
        <tr>
            <td colspan="7" style="text-align:center;padding:30px;color:var(--text-secondary);">
                <i class="fa-solid fa-spinner fa-spin" style="font-size:1.5rem;"></i><br>Loading closed queries...
            </td>
        </tr>`;

    const sheetRows = await fetchClosedQueriesFromSheet();
    tbody.innerHTML = '';

    if (sheetRows && sheetRows.length > 0) {
        sheetRows.forEach(row => {
            renderClosedRow(tbody, {
                txnId: String(row['Transaction ID'] || ''),
                date: row['Date'] || '',
                fullName: row['Full Name'] || '',
                email: row['Email'] || '',
                phone: row['Phone'] || '',
                amount: row['Amount'] || '',
                closedOn: row['Closed On'] || ''
            });
        });
    } else if (closedQueries.size > 0) {
        [...closedQueries].forEach(key => {
            const d = closedQueriesDetails[key] || {};
            renderClosedRow(tbody, {
                txnId: d.txnId || key,
                date: d.date || '',
                fullName: d.fullName || '',
                email: d.email || '',
                phone: d.phone || '',
                amount: d.amount || '',
                closedOn: d.closedOn || ''
            });
        });
    } else {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 7;
        td.style.cssText = 'text-align:center;color:var(--text-secondary);padding:50px;';
        td.innerHTML = '<i class="fa-solid fa-inbox" style="font-size:2.5rem;display:block;margin-bottom:12px;opacity:0.5;"></i>No closed queries yet.';
        tr.appendChild(td);
        tbody.appendChild(tr);
    }
}

function renderClosedRow(tbody, { txnId, date, fullName, email, phone, amount, closedOn }) {
    const tr = document.createElement('tr');
    const cells = [
        txnId, date, fullName, email, phone, amount, closedOn,
        '<span class="status-closed-badge"><i class="fa-solid fa-circle-check"></i> Closed</span>'
    ];
    cells.forEach((content, i) => {
        const td = document.createElement('td');
        if (i === 7) td.innerHTML = content;
        else td.textContent = content;
        tr.appendChild(td);
    });
    tbody.appendChild(tr);
}

// ═══════════════════════════════════════════════════════════════════
//  BADGE & STATS HELPERS
// ═══════════════════════════════════════════════════════════════════
function updateClosedBadge() {
    const badge = document.getElementById('closed-count-badge');
    if (badge) badge.textContent = closedQueries.size;
    const rejBadge = document.getElementById('rejected-count-badge');
    if (rejBadge) rejBadge.textContent = rejectedPayments.size;
}

function updateStats() {
    const grouped = getGroupedData();
    const totalLeads = Object.keys(grouped).length;
    const closedCount = closedQueries.size;
    const openCount = Object.keys(grouped).filter(key => !closedQueries.has(key)).length;

    document.getElementById('total-users').innerText = totalLeads;
    document.getElementById('active-chats').innerText = openCount;

    const today = new Date().toLocaleDateString();
    const newTodayCount = Object.values(grouped).filter(g => g.date === today).length;
    document.getElementById('new-today').innerText = newTodayCount;
    document.getElementById('queries-resolved').innerText = closedCount;
    const rejEl = document.getElementById('payments-rejected');
    if (rejEl) rejEl.innerText = rejectedPayments.size;
}

function getGroupedData() {
    const grouped = {};
    sheetData.forEach(row => {
        const txnId = String(row['Transaction ID'] || '').trim();
        if (!txnId) return;
        if (!grouped[txnId]) {
            grouped[txnId] = {
                txnId,
                date: row.Timestamp ? new Date(row.Timestamp).toLocaleDateString() : '',
                fullName: row['Full Name'] || '',
                email: row.Email || '',
                phone: row.Phone || '',
                service: row.Service || '',
                pkg: row.Package || '',
                amount: row.Amount || ''
            };
        }
    });
    return grouped;
}

// ═══════════════════════════════════════════════════════════════════
//  EXCEL EXPORT (fallback / offline)
// ═══════════════════════════════════════════════════════════════════
async function exportClosedQueriesToExcel() {
    const sheetRows = await fetchClosedQueriesFromSheet();
    let rows = [['Transaction ID', 'Date', 'Full Name', 'Email', 'Phone', 'Amount', 'Closed On', 'Status']];

    if (sheetRows && sheetRows.length > 0) {
        sheetRows.forEach(r => {
            rows.push([String(r['Transaction ID'] || ''), r['Date'] || '', r['Full Name'] || '',
                r['Email'] || '', r['Phone'] || '', r['Amount'] || '', r['Closed On'] || '', 'Closed']);
        });
    } else if (closedQueries.size > 0) {
        [...closedQueries].forEach(key => {
            const d = closedQueriesDetails[key] || {};
            rows.push([d.txnId || key, d.date || '', d.fullName || '',
                d.email || '', d.phone || '', d.amount || '', d.closedOn || '', 'Closed']);
        });
    } else {
        alert('No closed queries to export.');
        return;
    }

    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Closed Queries');
    XLSX.writeFile(wb, 'closed_queries.xlsx');
}

// ═══════════════════════════════════════════════════════════════════
//  UPDATE DATA (DISABLED)
// ═══════════════════════════════════════════════════════════════════
async function updateData(updates) {
    alert('Editing is disabled because the current Google Apps Script only supports adding new rows.');
}

// ═══════════════════════════════════════════════════════════════════
//  CHARTS
// ═══════════════════════════════════════════════════════════════════
function initCharts() {
    const chartOptions = {
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { labels: { color: '#f8fafc' } } }
    };

    pieChart = new Chart(document.getElementById('pieChart'), {
        type: 'pie',
        data: {
            labels: ['Open Queries', 'Closed Queries'],
            datasets: [{
                data: [0, 0],
                backgroundColor: ['#f59e0b', '#d4a843'],
                borderColor: '#0f0f0f',
                borderWidth: 2
            }]
        },
        options: chartOptions
    });

    barChart = new Chart(document.getElementById('barChart'), {
        type: 'bar',
        data: {
            labels: ['Open Queries', 'Closed Queries'],
            datasets: [{
                label: 'Count',
                data: [0, 0],
                backgroundColor: ['#f59e0b', '#d4a843'],
                borderColor: ['#f59e0b', '#d4a843'],
                borderWidth: 1
            }]
        },
        options: {
            ...chartOptions,
            scales: {
                y: { beginAtZero: true, ticks: { color: '#94a3b8' }, grid: { color: '#334155' } },
                x: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' } }
            }
        }
    });

    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        last7Days.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    }

    histogramChart = new Chart(document.getElementById('histogramChart'), {
        type: 'bar',
        data: {
            labels: last7Days,
            datasets: [
                { label: 'Total Queries', data: [0, 0, 0, 0, 0, 0, 0], backgroundColor: '#d4a843', borderColor: '#d4a843', borderWidth: 1 },
                { label: 'Open Queries', data: [0, 0, 0, 0, 0, 0, 0], backgroundColor: '#f59e0b', borderColor: '#f59e0b', borderWidth: 1 },
                { label: 'Closed Queries', data: [0, 0, 0, 0, 0, 0, 0], backgroundColor: '#e8c97a', borderColor: '#e8c97a', borderWidth: 1 }
            ]
        },
        options: {
            ...chartOptions,
            scales: {
                y: { beginAtZero: true, ticks: { color: '#94a3b8', stepSize: 1 }, grid: { color: '#334155' } },
                x: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' } }
            }
        }
    });
}

function updateCharts() {
    const totalQueries = Object.keys(getGroupedData()).length;
    const closedCount = closedQueries.size;
    const openCount = totalQueries - closedCount;

    pieChart.data.datasets[0].data = [openCount, closedCount];
    pieChart.update();

    barChart.data.datasets[0].data = [openCount, closedCount];
    barChart.update();

    const totalData = [0, 0, 0, 0, 0, 0, 0];
    const openData = [0, 0, 0, 0, 0, 0, 0];
    const closedData = [0, 0, 0, 0, 0, 0, 0];

    // Build a lookup of the last-7-days locale strings → array index
    const today = new Date();
    const dayLocale = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date();
        d.setDate(today.getDate() - (6 - i));
        dayLocale.push(d.toLocaleDateString());
    }

    const grouped = getGroupedData();
    Object.values(grouped).forEach(entry => {
        try {
            const idx = dayLocale.indexOf(new Date(entry.date).toLocaleDateString());
            if (idx === -1) return;
            totalData[idx]++;
            if (!closedQueries.has(entry.txnId)) openData[idx]++;
        } catch (e) { }
    });
    Object.values(closedQueriesDetails).forEach(detail => {
        if (!detail || !detail.closedOn) return;
        try {
            const idx = dayLocale.indexOf(new Date(detail.closedOn).toLocaleDateString());
            if (idx !== -1) closedData[idx]++;
        } catch (e) { }
    });

    histogramChart.data.datasets[0].data = totalData;
    histogramChart.data.datasets[1].data = openData;
    histogramChart.data.datasets[2].data = closedData;
    histogramChart.update();
}

