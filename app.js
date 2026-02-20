/* Meropenem Tracker Pro - Premium Edition
 * Modern Multi-Page Application
 * All data sending logic remains unchanged for Google Apps Script compatibility
 */

console.log('[Pro] Meropenem Tracker Pro loading...');

// ===== CONFIGURATION (UNCHANGED) =====
const GOOGLE_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwI12_KSHQ95cew4Q6f9W9je2_lCSgifqxDFayupc7deCypjUrZN6ROL66GzIB_elJH/exec';

const DB_NAME = 'MeropenemTrackerDB';
const DB_VERSION = 1;
const STORE_NAME = 'submissions';

// ===== STATE =====
let db = null;
let records = [];
let currentPatientId = null;

// Duplicate prevention (unchanged)
let isSubmitting = false;
let isUpdating = false;
let syncingRecords = new Set();
let lastSubmissionTime = 0;
let submissionQueue = new Map();
let syncedHashes = new Set();
const SUBMISSION_DEBOUNCE_TIME = 2000;

// ===== DATABASE FUNCTIONS (UNCHANGED) =====
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                const objectStore = database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                objectStore.createIndex('synced', 'synced', { unique: false });
                objectStore.createIndex('createdAt', 'createdAt', { unique: false });
                objectStore.createIndex('status', 'status', { unique: false });
                objectStore.createIndex('patientName', 'patientName', { unique: false });
            }
        };
        request.onsuccess = (event) => {
            db = event.target.result;
            resolve(db);
        };
    });
}

function getDB() {
    return new Promise((resolve, reject) => {
        if (db) { resolve(db); return; }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onsuccess = (e) => { db = e.target.result; resolve(db); };
        request.onerror = (e) => reject(e.target.error);
    });
}

async function addRecord(record) {
    const database = await getDB();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_NAME], 'readwrite');
        const objectStore = transaction.objectStore(STORE_NAME);
        const request = objectStore.add(record);
        request.onsuccess = () => {
            const newRecord = { ...record, id: request.result };
            records.unshift(newRecord);
            resolve(newRecord);
        };
        request.onerror = (e) => reject(e.target.error);
    });
}

async function updateRecord(id, updates) {
    const database = await getDB();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_NAME], 'readwrite');
        const objectStore = transaction.objectStore(STORE_NAME);
        const getRequest = objectStore.get(id);

        getRequest.onerror = (e) => reject(e);

        getRequest.onsuccess = () => {
            const data = getRequest.result;
            if (data) {
                const updatedRecord = { ...data, ...updates };
                const putRequest = objectStore.put(updatedRecord);

                putRequest.onsuccess = () => {
                    const index = records.findIndex(r => r.id === id);
                    if (index !== -1) {
                        records[index] = { ...updatedRecord };
                    }
                    resolve(updatedRecord);
                };

                putRequest.onerror = (e) => reject(e);
            } else {
                reject(new Error("Record not found"));
            }
        };
    });
}

async function deleteRecord(id) {
    const database = await getDB();
    const transaction = database.transaction([STORE_NAME], 'readwrite');
    const objectStore = transaction.objectStore(STORE_NAME);

    return new Promise((resolve, reject) => {
        const request = objectStore.delete(id);
        request.onsuccess = () => {
            records = records.filter(r => r.id !== id);
            resolve();
        };
        request.onerror = (e) => reject(e);
    });
}

async function getAllRecords() {
    const database = await getDB();
    return new Promise((resolve) => {
        const transaction = database.transaction([STORE_NAME], 'readonly');
        const request = transaction.objectStore(STORE_NAME).getAll();
        request.onsuccess = () => resolve(request.result);
    });
}

async function loadRecords() {
    records = await getAllRecords();
    records.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Auto calculate hospital day on app start for admitted patients (unchanged)
    records.forEach(record => {
        if (record.status === 'Admitted' && record.startDate) {
            const diffDays = Math.floor((new Date() - new Date(record.startDate)) / 86400000) + 1;
            record.currentHospitalDay = diffDays;
        }
    });

    updateDashboard();
    renderPatientsList();
    updatePendingBanner();
}

// ===== FORM HANDLING (NEW UI) =====
function getFormData() {
    const m1g = parseInt(document.getElementById('meropenem1gQuantity').value) || 0;
    const m05g = parseInt(document.getElementById('meropenem0_5gQuantity').value) || 0;
    return {
        patientName: document.getElementById('patientName').value.trim(),
        age: parseInt(document.getElementById('age').value) || 0,
        gender: document.getElementById('gender').value,
        diagnosis: document.getElementById('diagnosis').value,
        dosing: document.getElementById('dosing').value,
        sensitivityTest: document.getElementById('sensitivityTest').value,
        frequency: document.getElementById('frequency').value,
        pharmacistId: document.getElementById('pharmacistId').value.trim(),
        meropenem1gQuantity: m1g,
        meropenem0_5gQuantity: m05g,
        totalAmount: m1g + (m05g * 0.5),
    };
}

function updateTotalDisplay() {
    const m1g = parseInt(document.getElementById('meropenem1gQuantity').value) || 0;
    const m05g = parseInt(document.getElementById('meropenem0_5gQuantity').value) || 0;
    const total = m1g + (m05g * 0.5);
    document.getElementById('totalAmountDisplay').textContent = total.toFixed(1) + ' g';
}

function resetNewPatientForm() {
    document.getElementById('newPatientForm').reset();
    updateTotalDisplay();
}

// ===== SUBMIT RECORD (UNCHANGED LOGIC, NEW UI) =====
async function submitNewPatient(e) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }

    const currentTime = Date.now();

    // DEBOUNCE: Prevent submissions within 2 seconds of last submission
    if (currentTime - lastSubmissionTime < SUBMISSION_DEBOUNCE_TIME) {
        console.warn('[Pro] Submission too soon, please wait. Time since last:', currentTime - lastSubmissionTime, 'ms');
        showToast('info', 'Please wait before submitting again');
        return;
    }

    // Prevent duplicate submissions
    if (isSubmitting) {
        console.warn('[Pro] Submission already in progress, ignoring duplicate request');
        return;
    }

    const formData = getFormData();

// VALIDATION
    if(!formData.dosing) { showToast('error', 'Please select a dosing amount'); return; }
    if(!formData.sensitivityTest) { showToast('error', 'Please select Sensitivity Test result'); return; }
    if(formData.totalAmount === 0) { showToast('error', 'Please add vials'); return; }
    if(!formData.pharmacistId) { showToast('error', 'Please enter Pharmacist ID'); return; }

    // CREATE UNIQUE HASH FOR THIS SUBMISSION
    const submissionHash = `${formData.patientName}_${formData.age}_${formData.gender}_${formData.diagnosis}_${formData.dosing}_${formData.frequency}_${formData.duration}_${formData.meropenem1gQuantity}_${formData.meropenem0_5gQuantity}`;

    // Check if this exact same submission is already in the queue
    if (submissionQueue.has(submissionHash)) {
        const queuedTime = submissionQueue.get(submissionHash);
        console.warn('[Pro] This exact submission is already queued (submitted', currentTime - queuedTime, 'ms ago)');
        showToast('info', 'This record is already being submitted');
        return;
    }

    // Set submitting flag and update last submission time
    isSubmitting = true;
    lastSubmissionTime = currentTime;

    // Add to submission queue
    submissionQueue.set(submissionHash, currentTime);

    // Clean up old entries from submission queue (older than 10 seconds)
    for (const [hash, time] of submissionQueue.entries()) {
        if (currentTime - time > 10000) {
            submissionQueue.delete(hash);
        }
    }

    const btn = document.getElementById('submitBtn');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';

    // Show processing overlay
    showProcessingOverlay();

    try {
        // 1. Add to Local DB (Status: pending) with Hospital Admission Tracking
        const submissionTimestamp = new Date().toISOString();
        const newRecord = await addRecord({
            ...formData,
            createdAt: submissionTimestamp,
            synced: false,
            syncedAt: null,
            // Duration is calculated automatically - starts at 1 day
            duration: 1,
            // Hospital Admission Tracking
            startDate: submissionTimestamp,
            status: "Admitted",
            currentHospitalDay: 1,
            dailyUpdates: [],
            dischargeDate: null,
            submissionId: Date.now().toString(),
            submissionHash: submissionHash
        });

        console.log('[Pro] Record saved with ID:', newRecord.id, 'submissionId:', newRecord.submissionId, 'hash:', submissionHash);

        // Data will be synced to Google Sheets only when patient is discharged
        showToast('success', 'Record Saved Locally - Will sync on discharge');

        // 3. Update UI
        updatePendingBanner();
        resetNewPatientForm();
        showPage('dashboard');
    } catch (err) {
        showToast('error', 'Save Failed');
        console.error('[Pro] Submit error:', err);
    } finally {
        // Clear submitting flag and re-enable button
        isSubmitting = false;
        btn.disabled = false;
        btn.innerHTML = originalText;

        // Hide processing overlay
        hideProcessingOverlay();

        // Remove from submission queue after processing
        submissionQueue.delete(submissionHash);
    }
}

// ===== SYNC LOGIC (COMPLETELY UNCHANGED) =====
async function syncRecord(record) {
    // DUPLICATE PREVENTION: If already synced, do nothing
    if (record.synced) return;

    // Check if this submission hash has already been synced
    if (record.submissionHash && syncedHashes.has(record.submissionHash)) {
        console.warn('[Pro] Submission hash', record.submissionHash, 'already synced, skipping');
        await updateRecord(record.id, { synced: true, syncedAt: new Date().toISOString() });
        return;
    }

    // Prevent syncing the same record multiple times simultaneously
    if (syncingRecords.has(record.id)) {
        console.warn('[Pro] Record', record.id, 'is already being synced, skipping');
        return;
    }

    syncingRecords.add(record.id);

    try {
        // ⚠️ IMPORTANT: Use EXACT SAME payload format as original code
        // Do NOT add new keys to payload. Do NOT remove any keys.
        const payload = {
            timestamp: record.createdAt,
            patientName: record.patientName,
            age: record.age,
            gender: record.gender,
            diagnosis: record.diagnosis,
            dosing: record.dosing,
            sensitivityTest: record.sensitivityTest,
            frequency: record.frequency,
            duration: record.duration,
            pharmacistId: record.pharmacistId || '',
            meropenem1gQuantity: record.meropenem1gQuantity,
            meropenem0_5gQuantity: record.meropenem0_5gQuantity,
            syncStatus: 'Synced',
        };

        console.log('[Pro] Syncing record:', record.id, 'hash:', record.submissionHash, 'for patient:', record.patientName);
        console.log('[Pro] SYNCING PAYLOAD - Duration:', payload.duration, 'days, 1g vials:', payload.meropenem1gQuantity, '0.5g vials:', payload.meropenem0_5gQuantity, 'Total grams:', (payload.meropenem1gQuantity + payload.meropenem0_5gQuantity * 0.5).toFixed(1));

        await fetch(GOOGLE_APPS_SCRIPT_URL, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        await updateRecord(record.id, { synced: true, syncedAt: new Date().toISOString() });

        if (record.submissionHash) {
            syncedHashes.add(record.submissionHash);
        }

        console.log('[Pro] Record synced successfully:', record.id);
    } catch (err) {
        console.error('[Pro] Sync error for record', record.id, ':', err);
        throw err;
    } finally {
        syncingRecords.delete(record.id);
    }
}

async function syncAllRecords() {
    const unsynced = records.filter(r => !r.synced);
    if (unsynced.length === 0) return showToast('info', 'No pending records to sync');

    showToast('info', 'Syncing ' + unsynced.length + ' records...');
    let successCount = 0;

    for (const r of unsynced) {
        try {
            await syncRecord(r);
            successCount++;
        } catch (e) {
            console.error("Failed to sync record", r.id, e);
        }
        await new Promise(res => setTimeout(res, 500));
    }

    if (successCount > 0) {
        showToast('success', successCount + ' records synced');
    } else {
        showToast('error', 'Sync failed. Check connection.');
    }

    updatePendingBanner();
    renderPatientsList();
}

// ===== DAILY UPDATE (ENHANCED UI) =====
function openDailyUpdateModal(recordId) {
    const record = records.find(r => r.id === recordId);
    if (!record) return;

    currentPatientId = recordId;

    document.getElementById('modalCurrentDay').textContent = record.currentHospitalDay + 1;
    document.getElementById('modalHospitalDay').textContent = record.currentHospitalDay + 1;
    document.getElementById('modalPatientName').textContent = record.patientName;
    document.getElementById('updateMeropenem1gQuantity').value = '';
    document.getElementById('updateMeropenem0_5gQuantity').value = '';
    document.getElementById('updateNotes').value = '';
    document.getElementById('newTotalAfterUpdate').textContent = record.totalAmount.toFixed(1) + ' g';

    // Add live total calculation
    document.getElementById('updateMeropenem1gQuantity').oninput = calculateNewTotal;
    document.getElementById('updateMeropenem0_5gQuantity').oninput = calculateNewTotal;

    document.getElementById('dailyUpdateModal').classList.add('active');
}

function calculateNewTotal() {
    const record = records.find(r => r.id === currentPatientId);
    if (!record) return;

    const m1g = parseInt(document.getElementById('updateMeropenem1gQuantity').value) || 0;
    const m05g = parseInt(document.getElementById('updateMeropenem0_5gQuantity').value) || 0;
    const newTotal = record.totalAmount + m1g + (m05g * 0.5);

    document.getElementById('newTotalAfterUpdate').textContent = newTotal.toFixed(1) + ' g';
}

function closeDailyUpdateModal() {
    document.getElementById('dailyUpdateModal').classList.remove('active');
    currentPatientId = null;
}

async function saveDailyUpdate() {
    if (currentPatientId === null) return;

    // Prevent duplicate updates
    if (isUpdating) {
        console.warn('[Pro] Daily update already in progress, ignoring duplicate request');
        return;
    }

    const record = records.find(r => r.id === currentPatientId);
    if (!record) return;

    const meropenem1gQuantity = parseInt(document.getElementById('updateMeropenem1gQuantity').value) || 0;
    const meropenem0_5gQuantity = parseInt(document.getElementById('updateMeropenem0_5gQuantity').value) || 0;
    const notes = document.getElementById('updateNotes').value.trim();

    if (meropenem1gQuantity === 0 && meropenem0_5gQuantity === 0) {
        showToast('error', 'Please enter at least one vial quantity');
        return;
    }

    isUpdating = true;

    // Increase current hospital day by +1
    const newDay = record.currentHospitalDay + 1;

    // Add entry to dailyUpdates
    const newDailyUpdate = {
        day: newDay,
        date: new Date().toISOString(),
        meropenem1gQuantity,
        meropenem0_5gQuantity,
        notes
    };

    // Calculate new total
    const newTotal = record.totalAmount + meropenem1gQuantity + (meropenem0_5gQuantity * 0.5);

    try {
        // Capture the returned updated record directly from updateRecord
        const updatedRecord = await updateRecord(currentPatientId, {
            currentHospitalDay: newDay,
            duration: newDay, // Duration automatically increases with each daily update
            dailyUpdates: [...(record.dailyUpdates || []), newDailyUpdate],
            totalAmount: newTotal,
            meropenem1gQuantity: record.meropenem1gQuantity + meropenem1gQuantity,
            meropenem0_5gQuantity: record.meropenem0_5gQuantity + meropenem0_5gQuantity,
            synced: false
        });

        console.log('[Pro] Daily update saved for patient:', record.patientName, 'Day:', newDay);
        console.log('[Pro] Updated totals - 1g:', updatedRecord.meropenem1gQuantity, '0.5g:', updatedRecord.meropenem0_5gQuantity, 'Total:', updatedRecord.totalAmount);
        showToast('success', `Daily Update Saved - Day ${newDay}`);
        closeDailyUpdateModal();

        // Data will be synced to Google Sheets when patient is discharged
        console.log('[Pro] Data will sync to Google Sheets on discharge');

        // Refresh views
        if (document.getElementById('patientDetailPage').classList.contains('active')) {
            renderPatientDetail(currentPatientId);
        }
        renderPatientsList();
        updateDashboard();
        updatePendingBanner();
    } catch (err) {
        showToast('error', 'Failed to save daily update');
        console.error('[Pro] Daily update error:', err);
    } finally {
        isUpdating = false;
    }
}

// ===== DISCHARGE PATIENT (NEW UI) =====
async function dischargePatient(recordId) {
    const record = records.find(r => r.id === recordId);
    if (!record) return;

    if (!confirm(`Discharge patient ${record.patientName}?`)) return;

    try {
        // Capture the returned updated record directly from updateRecord
        const updatedRecord = await updateRecord(recordId, {
            status: 'Discharged',
            dischargeDate: new Date().toISOString(),
            duration: record.currentHospitalDay, // Duration = total days in hospital
            synced: false
        });

        console.log('[Pro] Patient discharged:', updatedRecord.patientName, 'Duration:', updatedRecord.duration, 'days', 'Syncing final totals - 1g:', updatedRecord.meropenem1gQuantity, '0.5g:', updatedRecord.meropenem0_5gQuantity, 'Total:', updatedRecord.totalAmount);
        showToast('success', 'Patient Discharged Successfully');

        // Remove from synced hashes to allow resync with updated status
        if (updatedRecord && updatedRecord.submissionHash) {
            syncedHashes.delete(updatedRecord.submissionHash);
        }

        // Sync final totals to Google Sheets (using the returned updatedRecord from DB)
        if (navigator.onLine) {
            try {
                await syncRecord(updatedRecord);
                showToast('info', 'Final totals synced to Google Sheets');
            } catch (syncErr) {
                console.error("Sync failed after discharge", syncErr);
                showToast('warning', 'Patient discharged (sync pending)');
            }
        } else {
            showToast('warning', 'Patient discharged (sync pending)');
        }

        renderPatientDetail(recordId);
        renderPatientsList();
        updateDashboard();
        updatePendingBanner();
    } catch (err) {
        showToast('error', 'Failed to discharge patient');
        console.error(err);
    }
}

async function deletePatient(recordId) {
    if(confirm('Delete this record permanently? This cannot be undone.')) {
        await deleteRecord(recordId);
        showToast('success', 'Record Deleted');
        renderPatientsList();
        updateDashboard();
        updatePendingBanner();
        showPage('patients');
    }
}

// ===== UI RENDERING =====
function updateDashboard() {
    const total = records.length;
    const admitted = records.filter(r => r.status === 'Admitted').length;
    const discharged = records.filter(r => r.status === 'Discharged').length;
    const totalVials = records.reduce((sum, r) => sum + r.totalAmount, 0);

    document.getElementById('totalPatients').textContent = total;
    document.getElementById('admittedPatients').textContent = admitted;
    document.getElementById('dischargedPatients').textContent = discharged;
    document.getElementById('totalVials').textContent = totalVials.toFixed(1);

    // Render recent patients
    const recentContainer = document.getElementById('recentPatientsList');
    const recent = records.slice(0, 5);

    if (recent.length === 0) {
        recentContainer.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon"><i class="fas fa-users"></i></div>
                <div class="empty-title">No patients yet</div>
                <div class="empty-text">Admit your first patient to get started</div>
            </div>
        `;
    } else {
        recentContainer.innerHTML = recent.map(r => createPatientCard(r, true)).join('');
    }
}

function renderPatientsList(filteredRecords = null) {
    const patientsToRender = filteredRecords || records;
    const container = document.getElementById('patientsList');

    if (patientsToRender.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon"><i class="fas fa-search"></i></div>
                <div class="empty-title">No patients found</div>
                <div class="empty-text">Try adjusting your search or add a new patient</div>
            </div>
        `;
        return;
    }

    container.innerHTML = patientsToRender.map(r => createPatientCard(r)).join('');
}

function createPatientCard(record, isCompact = false) {
    const initials = record.patientName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    const statusBadge = record.status === 'Admitted'
        ? '<span class="badge badge-success">Admitted</span>'
        : '<span class="badge badge-warning">Discharged</span>';

    if (isCompact) {
        return `
            <div class="patient-card" onclick="viewPatient(${record.id})">
                <div class="patient-header">
                    <div class="patient-avatar">${initials}</div>
                    <div class="patient-info">
                        <div class="patient-name">${record.patientName}</div>
                        <div class="patient-meta">
                            <span>${record.age} yrs</span>
                            <span>•</span>
                            <span>${record.diagnosis}</span>
                        </div>
                    </div>
                    ${statusBadge}
                </div>
            </div>
        `;
    }

    return `
        <div class="patient-card" onclick="viewPatient(${record.id})">
            <div class="patient-header">
                <div class="patient-avatar">${initials}</div>
                <div class="patient-info">
                    <div class="patient-name">${record.patientName}</div>
                    <div class="patient-meta">
                        <span><i class="fas fa-user"></i> ${record.age} yrs</span>
                        <span><i class="fas fa-venus-mars"></i> ${record.gender}</span>
                        <span><i class="fas fa-procedures"></i> ${record.diagnosis}</span>
                    </div>
                </div>
                ${statusBadge}
            </div>
            <div class="patient-stats">
                <div class="patient-stat">
                    <div class="patient-stat-value">${record.currentHospitalDay || 0}</div>
                    <div class="patient-stat-label">Day</div>
                </div>
                <div class="patient-stat">
                    <div class="patient-stat-value">${record.totalAmount.toFixed(1)}</div>
                    <div class="patient-stat-label">Total (g)</div>
                </div>
                <div class="patient-stat">
                    <div class="patient-stat-value">${record.frequency}h</div>
                    <div class="patient-stat-label">Freq</div>
                </div>
                <div class="patient-stat">
                    <div class="patient-stat-value">${record.dosing}</div>
                    <div class="patient-stat-label">Dose</div>
                </div>
            </div>
        </div>
    `;
}

function viewPatient(recordId) {
    currentPatientId = recordId;
    renderPatientDetail(recordId);
    showPage('patientDetail');
}

function renderPatientDetail(recordId) {
    const record = records.find(r => r.id === recordId);
    if (!record) return;

    const initials = record.patientName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    const isAdmitted = record.status === 'Admitted';

    // Build timeline
    let timelineHTML = '';

    // Add admission record
    timelineHTML += `
        <div class="timeline-item">
            <div class="timeline-date">${new Date(record.createdAt).toLocaleDateString()} ${new Date(record.createdAt).toLocaleTimeString()}</div>
            <div class="timeline-content">
                <div class="timeline-title">🏥 Patient Admitted</div>
                <div class="timeline-details">
                    <strong>Initial Dispensing:</strong> ${record.meropenem1gQuantity} × 1g + ${record.meropenem0_5gQuantity} × 0.5g
                    <br>
                    <strong>Diagnosis:</strong> ${record.diagnosis}
                    <br>
                    <strong>Dosing:</strong> ${record.dosing} every ${record.frequency} hours
                    <br>
                    <strong>Sensitivity Test:</strong> ${record.sensitivityTest}
                </div>
            </div>
        </div>
    `;

    // Add daily updates
    if (record.dailyUpdates && record.dailyUpdates.length > 0) {
        record.dailyUpdates.forEach(update => {
            timelineHTML += `
                <div class="timeline-item">
                    <div class="timeline-date">${new Date(update.date).toLocaleDateString()} ${new Date(update.date).toLocaleTimeString()}</div>
                    <div class="timeline-content">
                        <div class="timeline-title">💊 Day ${update.day} - Daily Update</div>
                        <div class="timeline-details">
                            <strong>Dispensed:</strong> ${update.meropenem1gQuantity} × 1g + ${update.meropenem0_5gQuantity} × 0.5g
                            ${update.notes ? `<br><strong>Notes:</strong> ${update.notes}` : ''}
                        </div>
                    </div>
                </div>
            `;
        });
    }

    // Add discharge record if discharged
    if (record.status === 'Discharged' && record.dischargeDate) {
        timelineHTML += `
            <div class="timeline-item">
                <div class="timeline-date">${new Date(record.dischargeDate).toLocaleDateString()} ${new Date(record.dischargeDate).toLocaleTimeString()}</div>
                <div class="timeline-content">
                    <div class="timeline-title">🏠 Patient Discharged</div>
                    <div class="timeline-details">
                        <strong>Total Treatment Period:</strong> ${record.currentHospitalDay} days
                        <br>
                        <strong>Total Dispensed:</strong> ${record.totalAmount.toFixed(1)}g
                    </div>
                </div>
            </div>
        `;
    }

    // Build day tracker
    let dayTrackerHTML = '';
    if (isAdmitted && record.dailyUpdates && record.dailyUpdates.length > 0) {
        dayTrackerHTML = `
            <h3 style="font-size: 1rem; margin: var(--spacing-lg) 0 var(--spacing-md);" class="text-gradient">Treatment Timeline</h3>
            <div class="day-tracker">
                <div class="day-item completed">1</div>
        `;
        
        for (let i = 2; i <= record.currentHospitalDay; i++) {
            dayTrackerHTML += `<div class="day-item ${i === record.currentHospitalDay ? 'current' : 'completed'}">${i}</div>`;
        }
        
        dayTrackerHTML += `</div>`;
    }

    const content = `
        <!-- Patient Header Card -->
        <div class="card" style="margin-bottom: var(--spacing-lg);">
            <div class="patient-header" style="margin-bottom: 0;">
                <div class="patient-avatar" style="width: 64px; height: 64px; font-size: 1.8rem;">${initials}</div>
                <div class="patient-info">
                    <div class="patient-name" style="font-size: 1.3rem;">${record.patientName}</div>
                    <div class="patient-meta">
                        <span><i class="fas fa-birthday-cake"></i> ${record.age} years</span>
                        <span><i class="fas fa-venus-mars"></i> ${record.gender}</span>
                        ${isAdmitted 
                            ? '<span class="badge badge-success"><i class="fas fa-bed"></i> Admitted</span>'
                            : '<span class="badge badge-warning"><i class="fas fa-home"></i> Discharged</span>'
                        }
                    </div>
                </div>
            </div>
        </div>

        <!-- Quick Stats -->
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-value" style="font-size: 1.5rem;">${record.currentHospitalDay || 0}</div>
                <div class="stat-label">Hospital Day</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" style="font-size: 1.5rem;">${record.totalAmount.toFixed(1)}</div>
                <div class="stat-label">Total (g)</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" style="font-size: 1.5rem;">${record.dosing}</div>
                <div class="stat-label">Per Dose</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" style="font-size: 1.5rem;">${record.frequency}h</div>
                <div class="stat-label">Frequency</div>
            </div>
        </div>

        <!-- Treatment Info -->
        <div class="card">
            <div class="card-header">
                <div class="card-title">
                    <i class="fas fa-notes-medical"></i>
                    Treatment Details
                </div>
            </div>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--spacing-md);">
                <div>
                    <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: var(--spacing-xs);">Diagnosis</div>
                    <div style="font-weight: 600;">${record.diagnosis}</div>
                </div>
                <div>
                    <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: var(--spacing-xs);">Sensitivity Test</div>
                    <div>
                        <span class="badge ${record.sensitivityTest === 'نعم' ? 'badge-success' : 'badge-warning'}">
                            ${record.sensitivityTest}
                        </span>
                    </div>
                </div>
                <div>
                    <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: var(--spacing-xs);">Duration</div>
                    <div style="font-weight: 600;">${record.duration} days <span style="font-size: 0.7rem; color: var(--text-muted);">(auto-calculated)</span></div>
                </div>
                <div>
                    <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: var(--spacing-xs);">Admitted</div>
                    <div style="font-weight: 600;">${new Date(record.startDate).toLocaleDateString()}</div>
                </div>
            </div>
        </div>

        ${dayTrackerHTML}

        <!-- Timeline -->
        <div class="card">
            <div class="card-header">
                <div class="card-title">
                    <i class="fas fa-history"></i>
                    Treatment History
                </div>
            </div>
            <div class="timeline">
                ${timelineHTML}
            </div>
        </div>

        <!-- Actions -->
        ${isAdmitted ? `
            <div class="card">
                <div class="card-header">
                    <div class="card-title">
                        <i class="fas fa-tasks"></i>
                        Actions
                    </div>
                </div>
                <div class="form-row">
                    <button class="btn btn-primary btn-full" onclick="openDailyUpdateModal(${record.id})">
                        <i class="fas fa-calendar-plus"></i>
                        Add Daily Update
                    </button>
                    <button class="btn btn-success btn-full" onclick="dischargePatient(${record.id})">
                        <i class="fas fa-home"></i>
                        Discharge Patient
                    </button>
                </div>
            </div>
        ` : ''}

        <div class="card">
            <div class="card-header">
                <div class="card-title">
                    <i class="fas fa-cog"></i>
                    Record Management
                </div>
            </div>
            <div class="form-row">
                <button class="btn btn-secondary btn-full" onclick="deletePatient(${record.id})">
                    <i class="fas fa-trash"></i>
                    Delete Record
                </button>
            </div>
        </div>
    `;

    document.getElementById('patientDetailContent').innerHTML = content;
}

function filterPatients() {
    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
    const filtered = records.filter(r =>
        r.patientName.toLowerCase().includes(searchTerm) ||
        r.diagnosis.toLowerCase().includes(searchTerm) ||
        r.age.toString().includes(searchTerm)
    );
    renderPatientsList(filtered);
}

// ===== PAGE NAVIGATION =====
function showPage(pageId) {
    // Hide all pages
    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });

    // Show target page
    const targetPage = document.getElementById(pageId + 'Page');
    if (targetPage) {
        targetPage.classList.add('active');
    }

    // Update navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.page === pageId) {
            item.classList.add('active');
        }
    });

    // Refresh page-specific content
    if (pageId === 'dashboard') {
        updateDashboard();
    } else if (pageId === 'patients') {
        renderPatientsList();
    }

    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ===== TOAST NOTIFICATIONS =====
function showToast(type, msg) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = {
        success: 'fa-check',
        error: 'fa-times',
        info: 'fa-info'
    };

    toast.innerHTML = `
        <div class="toast-icon">
            <i class="fas ${icons[type] || icons.info}"></i>
        </div>
        <div class="toast-content">
            <div class="toast-title">${type.charAt(0).toUpperCase() + type.slice(1)}</div>
            <div class="toast-message">${msg}</div>
        </div>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100px)';
        toast.style.transition = 'all var(--transition-base)';
        setTimeout(() => toast.remove(), 200);
    }, 3500);
}

// ===== PROCESSING OVERLAY =====
function showProcessingOverlay() {
    const overlay = document.getElementById('processingOverlay');
    if (overlay) {
        overlay.classList.add('active');
    }
}

function hideProcessingOverlay() {
    const overlay = document.getElementById('processingOverlay');
    if (overlay) {
        overlay.classList.remove('active');
    }
}

// ===== PENDING BANNER =====
function updatePendingBanner() {
    const pending = records.filter(r => !r.synced).length;
    document.getElementById('pendingRecordsCount').textContent = pending;
}

// ===== EXPORT TO CSV =====
function exportToCSV() {
    if (records.length === 0) return showToast('info', 'No data to export');
    const headers = ['Date', 'Patient', 'Age', 'Gender', 'Diagnosis', 'Dosing', 'Sensitivity', 'Frequency', 'Total(g)', 'Status', 'Hospital Day', 'Sync Status'];
    const rows = records.map(r => [
        r.createdAt, r.patientName, r.age, r.gender, r.diagnosis, r.dosing, r.sensitivityTest, r.frequency, r.totalAmount, r.status || 'Admitted', r.currentHospitalDay || 0, r.synced ? 'Synced' : 'Pending'
    ]);

    let csv = headers.join(',') + '\n' + rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'meropenem_pro_export.csv';
    a.click();
}

// ===== DUPLICATE DETECTION =====
function detectDuplicates() {
    const duplicates = [];
    const seen = new Map();

    records.forEach(record => {
        const key = `${record.patientName}_${record.age}_${record.diagnosis}`;
        const timestamp = new Date(record.createdAt).getTime();

        if (seen.has(key)) {
            const existing = seen.get(key);
            const existingTimestamp = new Date(existing.createdAt).getTime();

            if (Math.abs(timestamp - existingTimestamp) < 1000) {
                duplicates.push({ existing, duplicate: record });
            }
        } else {
            seen.set(key, record);
        }
    });

    if (duplicates.length > 0) {
        console.warn('[Pro] Detected', duplicates.length, 'potential duplicate records:', duplicates);
        showToast('info', `Detected ${duplicates.length} potential duplicate records. Check console for details.`);
    }

    return duplicates;
}

// ===== INITIALIZATION =====
async function initApp() {
    try {
        console.log('[Pro] Initializing...');
        await initDB();
        console.log('[Pro] Database initialized');
        await loadRecords();
        console.log('[Pro] Records loaded');

        // Check for duplicates
        detectDuplicates();

        document.getElementById('loadingScreen').style.display = 'none';
        document.getElementById('app').style.display = 'block';
        console.log('[Pro] App started successfully');
    } catch (err) {
        console.error('[Pro] Initialization error:', err);
        document.getElementById('loadingScreen').innerHTML = `
            <div style="text-align: center; padding: var(--spacing-lg);">
                <i class="fas fa-exclamation-triangle" style="font-size: 3rem; color: var(--danger); margin-bottom: var(--spacing-md);"></i>
                <div style="font-size: 1.2rem; margin-bottom: var(--spacing-sm);">Initialization Error</div>
                <div style="color: var(--text-secondary);">${err.message}</div>
                <button class="btn btn-primary" style="margin-top: var(--spacing-md);" onclick="location.reload()">
                    <i class="fas fa-redo"></i>
                    Retry
                </button>
            </div>
        `;
    }
}

// ===== eGFR CALCULATOR (Three Methods) =====

// Method selection function
function selectMethod(method) {
    // Update UI
    document.querySelectorAll('.method-option').forEach(option => {
        option.classList.remove('active');
    });
    document.querySelector(`[data-method="${method}"]`).classList.add('active');

    // Update hidden input
    document.getElementById('eGFR_Method').value = method;

    // Show/hide weight field based on method
    const weightField = document.getElementById('weightField');
    const raceField = document.getElementById('raceField');

    if (method === 'cockcroft') {
        weightField.style.display = 'block';
        raceField.style.display = 'none';
    } else {
        weightField.style.display = 'none';
        raceField.style.display = 'block';
    }

    // Hide result when method changes
    document.getElementById('eGFR_Result').style.display = 'none';

    console.log('[eGFR] Method selected:', method);
}

// CKD-EPI Formula
function calculateCKDEPI(creatinine, age, gender, isBlack) {
    let egfr = 0;

    if (gender === 'female') {
        if (creatinine <= 0.7) {
            egfr = 141 * Math.pow(creatinine / 0.7, -0.329) * Math.pow(0.993, age);
        } else {
            egfr = 141 * Math.pow(creatinine / 0.7, -1.209) * Math.pow(0.993, age);
        }
        if (isBlack) {
            egfr *= 1.018;
        }
    } else { // male
        if (creatinine <= 0.9) {
            egfr = 141 * Math.pow(creatinine / 0.9, -0.411) * Math.pow(0.993, age);
        } else {
            egfr = 141 * Math.pow(creatinine / 0.9, -1.209) * Math.pow(0.993, age);
        }
        if (isBlack) {
            egfr *= 1.159;
        }
    }

    return egfr;
}

// MDRD Formula (4-variable)
function calculateMDRD(creatinine, age, gender, isBlack) {
    let egfr = 175 * Math.pow(creatinine, -1.154) * Math.pow(age, -0.203);

    if (gender === 'female') {
        egfr *= 0.742;
    }

    if (isBlack) {
        egfr *= 1.212;
    }

    return egfr;
}

// Cockcroft-Gault Formula (for Creatinine Clearance)
function calculateCockcroftGault(creatinine, age, gender, weight) {
    let crcl = 0;

    // Convert to mL/min
    if (gender === 'female') {
        crcl = ((140 - age) * weight) / (72 * creatinine) * 0.85;
    } else { // male
        crcl = ((140 - age) * weight) / (72 * creatinine);
    }

    // Convert to mL/min/1.73m² (using average body surface area of 1.73 m²)
    // First calculate body surface area using Mosteller formula
    const height = 1.7; // Using average height in meters (can be made configurable)
    const bsa = Math.sqrt(height * weight) / 6;
    const adjustedCrcl = (crcl / bsa) * 1.73;

    return adjustedCrcl;
}

// Main calculation function
function calculateEGFR() {
    const method = document.getElementById('eGFR_Method').value;
    const creatinine = parseFloat(document.getElementById('eGFR_Creatinine').value);
    const age = parseInt(document.getElementById('eGFR_Age').value);
    const gender = document.getElementById('eGFR_Gender').value;

    // Validation
    if (!creatinine || !age || !gender) {
        showToast('error', 'Please fill in all required fields');
        return;
    }

    if (creatinine <= 0 || creatinine > 20) {
        showToast('error', 'Invalid creatinine value (0.1 - 20 mg/dL)');
        return;
    }

    let egfr = 0;
    let isBlack = false;
    let weight = 0;

    // Get race for CKD-EPI and MDRD
    if (method !== 'cockcroft') {
        const race = document.getElementById('eGFR_Race').value;
        if (!race) {
            showToast('error', 'Please select race');
            return;
        }
        isBlack = (race === 'black');
    }

    // Get weight for Cockcroft-Gault
    if (method === 'cockcroft') {
        weight = parseFloat(document.getElementById('eGFR_Weight').value);
        if (!weight || weight <= 0) {
            showToast('error', 'Please enter valid weight');
            return;
        }
    }

    // Calculate based on selected method
    switch(method) {
        case 'ckdepi':
            egfr = calculateCKDEPI(creatinine, age, gender, isBlack);
            break;
        case 'mDRD':
            egfr = calculateMDRD(creatinine, age, gender, isBlack);
            break;
        case 'cockcroft':
            egfr = calculateCockcroftGault(creatinine, age, gender, weight);
            break;
        default:
            egfr = calculateCKDEPI(creatinine, age, gender, isBlack);
    }

    // Round to 1 decimal place
    egfr = Math.round(egfr * 10) / 10;

    // Determine CKD category
    let category = '';
    let color = '';

    if (egfr >= 90) {
        category = 'Normal or mild CKD';
        color = '#10b981';
    } else if (egfr >= 60) {
        category = 'Mildly decreased (Stage 2)';
        color = '#3b82f6';
    } else if (egfr >= 45) {
        category = 'Mild to moderately decreased (Stage 3a)';
        color = '#f59e0b';
    } else if (egfr >= 30) {
        category = 'Moderately to severely decreased (Stage 3b)';
        color = '#ef4444';
    } else if (egfr >= 15) {
        category = 'Severely decreased (Stage 4)';
        color = '#dc2626';
    } else {
        category = 'Kidney failure (Stage 5)';
        color = '#991b1b';
    }

    // Get method name for display
    const methodNames = {
        'ckdepi': 'CKD-EPI',
        'mDRD': 'MDRD',
        'cockcroft': 'Cockcroft-Gault'
    };

    // Display result
    const resultDiv = document.getElementById('eGFR_Result');
    const valueDiv = document.getElementById('eGFR_Value');
    const categoryDiv = document.getElementById('eGFR_Category');

    valueDiv.textContent = egfr.toFixed(1);
    categoryDiv.innerHTML = `
        <span style="color: ${color};">●</span> ${category}
        <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">
            Calculated using ${methodNames[method]} formula
        </div>
    `;

    resultDiv.style.display = 'block';

    // Smooth scroll to result
    resultDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    console.log('[eGFR] Calculation complete - Method:', methodNames[method], 'eGFR:', egfr, 'Category:', category);
    showToast('success', `eGFR calculated using ${methodNames[method]} formula`);
}

// ===== EXPOSE FUNCTIONS =====
window.showPage = showPage;
window.submitNewPatient = submitNewPatient;
window.resetNewPatientForm = resetNewPatientForm;
window.viewPatient = viewPatient;
window.filterPatients = filterPatients;
window.openDailyUpdateModal = openDailyUpdateModal;
window.closeDailyUpdateModal = closeDailyUpdateModal;
window.saveDailyUpdate = saveDailyUpdate;
window.calculateNewTotal = calculateNewTotal;
window.calculateEGFR = calculateEGFR;
window.selectMethod = selectMethod;
window.dischargePatient = dischargePatient;
window.deletePatient = deletePatient;
window.syncAllRecords = syncAllRecords;
window.exportToCSV = exportToCSV;
window.updateTotalDisplay = updateTotalDisplay;
window.detectDuplicates = detectDuplicates;
window.showProcessingOverlay = showProcessingOverlay;
window.hideProcessingOverlay = hideProcessingOverlay;

// ===== START APP =====
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        console.log('[Pro] DOM ready, initializing...');
        initApp();
    });
} else {
    console.log('[Pro] DOM already loaded, initializing...');
    initApp();
}
