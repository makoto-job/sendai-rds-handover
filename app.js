/* ========================================
   仙台RDS 引継帳 — App Logic
   ======================================== */
'use strict';

// ---- Utility ----
function todayStr() { return new Date().toLocaleDateString('sv-SE'); }
function nowISO() { return new Date().toISOString(); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ---- Storage ----
const Store = {
  _get(key, def) { try { return JSON.parse(localStorage.getItem(key)) || def; } catch { return def; } },
  _set(key, val) { localStorage.setItem(key, JSON.stringify(val)); },

  // 日次データ: key = "hiki_{date}_{shift}" (shift: day|night)
  getSheet(date, shift) {
    return this._get(`hiki_${date}_${shift}`, null);
  },
  saveSheet(date, shift, data) {
    data.updatedAt = nowISO();
    this._set(`hiki_${date}_${shift}`, data);
    // 日付リストに追加
    const dates = this.getDates();
    const key = `${date}_${shift}`;
    if (!dates.includes(key)) { dates.push(key); dates.sort().reverse(); this._set('hiki_dates', dates); }
  },
  getDates() { return this._get('hiki_dates', []); },

  // 担当者
  getStaff() { return this._get('vha_staff', []); },
  saveStaff(list) { this._set('vha_staff', list); },

  // 設定
  getSetting(key, def) { return this._get('vha_s_' + key, def); },
  setSetting(key, val) { this._set('vha_s_' + key, val); },

  // エクスポート
  exportAll() {
    const dates = this.getDates();
    const sheets = {};
    dates.forEach(k => {
      const [date, shift] = k.split('_').length === 3
        ? [k.substring(0, 10), k.substring(11)]
        : k.split('_');
      sheets[k] = this._get(`hiki_${k}`, null);
    });
    return JSON.stringify({ version: 2, type: 'sendai_rds', exportedAt: nowISO(), staff: this.getStaff(), sheets }, null, 2);
  },
  importAll(json) {
    const data = JSON.parse(json);
    if (data.staff) this.saveStaff(data.staff);
    if (data.sheets) {
      Object.entries(data.sheets).forEach(([k, v]) => {
        if (v) this._set(`hiki_${k}`, v);
      });
      const dates = Object.keys(data.sheets);
      const existing = this.getDates();
      const merged = [...new Set([...existing, ...dates])].sort().reverse();
      this._set('hiki_dates', merged);
    }
    return Object.keys(data.sheets || {}).length;
  }
};

// ---- App ----
const App = {
  currentDate: todayStr(),
  currentShift: 'day',
  currentReactor: 'RX-01A',
  _voiceTarget: null,
  _editingEntryIdx: -1,

  init() {
    // Theme
    if (Store.getSetting('darkMode', false)) {
      document.documentElement.setAttribute('data-theme', 'dark');
      document.getElementById('toggle-dark').checked = true;
    }

    document.getElementById('date-select').value = this.currentDate;
    this.bindEvents();
    this.renderStaffSelect();
    this.renderWorkItems();
    this.renderCatalystOptions();
    this.loadSheet();
    this.checkOnline();

    // Firebase初期化（設定済みの場合のみ）
    FireSync.init((date, shift, remoteData) => {
      // リモートからの更新を受信したら画面を更新
      if (date === this.currentDate && shift === this.currentShift) {
        this._currentData = remoteData;
        this.loadSheet();
        this.showToast('他の端末から更新されました');
      }
    }).then(ok => {
      if (ok) {
        this.showToast('Firebase接続OK');
        FireSync.listenSheet(this.currentDate, this.currentShift);
      }
    });
  },

  // ---- Events ----
  bindEvents() {
    // Date
    document.getElementById('date-select').addEventListener('change', e => {
      this.currentDate = e.target.value;
      this.loadSheet();
    });

    // Shift toggle
    document.querySelectorAll('.shift-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.shift-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentShift = btn.dataset.shift;
        this.loadSheet();
      });
    });

    // Reactor tabs
    document.querySelectorAll('.reactor-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.reactor-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentReactor = btn.dataset.rx;
        this.renderEntries();
      });
    });

    // Add entry
    document.getElementById('btn-add-entry').addEventListener('click', () => this.openEntryModal());

    // Entry modal
    document.getElementById('btn-entry-close').addEventListener('click', () => this.closeEntryModal());
    document.getElementById('btn-entry-save').addEventListener('click', () => this.saveEntry());

    // Save button
    document.getElementById('btn-save').addEventListener('click', () => this.saveCurrentSheet());

    // Print
    document.getElementById('btn-print').addEventListener('click', () => this.printA4());

    // Menu
    document.getElementById('btn-menu').addEventListener('click', () => this.toggleMenu(true));
    document.getElementById('btn-menu-close').addEventListener('click', () => this.toggleMenu(false));
    document.querySelector('.side-menu-overlay')?.addEventListener('click', () => this.toggleMenu(false));

    // Dark mode
    document.getElementById('toggle-dark').addEventListener('change', e => {
      Store.setSetting('darkMode', e.target.checked);
      document.documentElement.setAttribute('data-theme', e.target.checked ? 'dark' : '');
    });

    // Staff management
    document.getElementById('btn-add-staff').addEventListener('click', () => this.addStaff());
    document.getElementById('staff-new').addEventListener('keydown', e => { if (e.key === 'Enter') this.addStaff(); });

    // Export / Import
    document.getElementById('btn-export').addEventListener('click', () => this.exportJSON());
    document.getElementById('btn-import').addEventListener('click', () => document.getElementById('import-file').click());
    document.getElementById('import-file').addEventListener('change', e => this.importJSON(e));
    document.getElementById('btn-export-all-pdf').addEventListener('click', () => this.exportAllPDF());

    // Firebase settings
    document.getElementById('btn-fb-save').addEventListener('click', () => this.saveFirebaseConfig());
    document.getElementById('btn-fb-upload').addEventListener('click', () => this.uploadToFirebase());
    this.loadFirebaseConfigUI();

    // Project name
    document.getElementById('setting-project-name').addEventListener('change', e => {
      Store.setSetting('projectName', e.target.value);
      document.getElementById('header-title').textContent = e.target.value;
    });

    // Voice buttons
    document.querySelectorAll('.btn-voice').forEach(btn => {
      btn.addEventListener('click', () => this.toggleVoice(btn.dataset.target, btn));
    });

    // Online/offline
    window.addEventListener('online', () => this.checkOnline());
    window.addEventListener('offline', () => this.checkOnline());

    // Auto-save on input change
    document.querySelectorAll('.main-content input, .main-content select, .main-content textarea').forEach(el => {
      el.addEventListener('change', () => this.autoSave());
    });
  },

  // ---- Load / Save Sheet ----
  _currentData: null,

  createEmptySheet() {
    return {
      date: this.currentDate,
      shift: this.currentShift,
      weather: '',
      supervisor: '',
      reactors: {
        'RX-01A': { entries: [], notes: '' },
        'RX-02A': { entries: [], notes: '' }
      },
      workChecks: {},
      stats: {
        nukiStart: '', nukiEnd: '', nukiCount: '', nukiTotal: '', level: '',
        workStart: '', workEnd: '', catalystTemp: '', dryIce: ''
      },
      inspection: { equipment: '', seiyu: '', gm: '', jieiho: '' },
      wbgt: [
        { temp: '', humidity: '', wbgt: '' },
        { temp: '', humidity: '', wbgt: '' },
        { temp: '', humidity: '', wbgt: '' }
      ],
      createdAt: nowISO(),
      updatedAt: nowISO()
    };
  },

  loadSheet() {
    const data = Store.getSheet(this.currentDate, this.currentShift);
    this._currentData = data || this.createEmptySheet();

    // Header
    const projName = Store.getSetting('projectName', '2026年仙台RDSリアクター触媒交換工事');
    document.getElementById('header-title').textContent = projName;
    document.getElementById('setting-project-name').value = projName;

    // Weather & supervisor
    document.getElementById('weather').value = this._currentData.weather || '';
    document.getElementById('supervisor').value = this._currentData.supervisor || '';

    // Entries
    this.renderEntries();

    // Work checks
    this.restoreWorkChecks();

    // Stats
    const s = this._currentData.stats || {};
    document.getElementById('stat-nuki-start').value = s.nukiStart || '';
    document.getElementById('stat-nuki-end').value = s.nukiEnd || '';
    document.getElementById('stat-nuki-count').value = s.nukiCount || '';
    document.getElementById('stat-nuki-total').value = s.nukiTotal || '';
    document.getElementById('stat-level').value = s.level || '';
    document.getElementById('stat-work-start').value = s.workStart || '';
    document.getElementById('stat-work-end').value = s.workEnd || '';
    document.getElementById('stat-temp').value = s.catalystTemp || '';
    document.getElementById('stat-dryice').value = s.dryIce || '';

    // Inspection
    const insp = this._currentData.inspection || {};
    document.getElementById('insp-equipment').value = insp.equipment || '';
    document.getElementById('insp-seiyu').value = insp.seiyu || '';
    document.getElementById('insp-gm').value = insp.gm || '';
    document.getElementById('insp-jieiho').value = insp.jieiho || '';

    // WBGT
    const wb = this._currentData.wbgt || [{}, {}, {}];
    for (let i = 0; i < 3; i++) {
      document.getElementById(`wbgt-t${i + 1}`).value = wb[i]?.temp || '';
      document.getElementById(`wbgt-h${i + 1}`).value = wb[i]?.humidity || '';
      document.getElementById(`wbgt-w${i + 1}`).value = wb[i]?.wbgt || '';
    }

    // Handover notes
    document.getElementById('handover-notes-rx1').value = this._currentData.reactors?.['RX-01A']?.notes || '';
    document.getElementById('handover-notes-rx2').value = this._currentData.reactors?.['RX-02A']?.notes || '';

    // Date list in menu
    this.renderDateList();

    // Firebaseリスナーを現在の日付/シフトに切替
    FireSync.listenSheet(this.currentDate, this.currentShift);
  },

  collectSheet() {
    const d = this._currentData;
    d.date = this.currentDate;
    d.shift = this.currentShift;
    d.weather = document.getElementById('weather').value;
    d.supervisor = document.getElementById('supervisor').value;

    // Stats
    d.stats = {
      nukiStart: document.getElementById('stat-nuki-start').value,
      nukiEnd: document.getElementById('stat-nuki-end').value,
      nukiCount: document.getElementById('stat-nuki-count').value,
      nukiTotal: document.getElementById('stat-nuki-total').value,
      level: document.getElementById('stat-level').value,
      workStart: document.getElementById('stat-work-start').value,
      workEnd: document.getElementById('stat-work-end').value,
      catalystTemp: document.getElementById('stat-temp').value,
      dryIce: document.getElementById('stat-dryice').value
    };

    // Inspection
    d.inspection = {
      equipment: document.getElementById('insp-equipment').value,
      seiyu: document.getElementById('insp-seiyu').value,
      gm: document.getElementById('insp-gm').value,
      jieiho: document.getElementById('insp-jieiho').value
    };

    // WBGT
    d.wbgt = [];
    for (let i = 0; i < 3; i++) {
      d.wbgt.push({
        temp: document.getElementById(`wbgt-t${i + 1}`).value,
        humidity: document.getElementById(`wbgt-h${i + 1}`).value,
        wbgt: document.getElementById(`wbgt-w${i + 1}`).value
      });
    }

    // Work checks
    d.workChecks = {};
    document.querySelectorAll('.work-check').forEach(cb => {
      if (cb.checked) d.workChecks[cb.dataset.item] = true;
    });

    // Handover notes
    if (!d.reactors) d.reactors = { 'RX-01A': { entries: [], notes: '' }, 'RX-02A': { entries: [], notes: '' } };
    d.reactors['RX-01A'].notes = document.getElementById('handover-notes-rx1').value;
    d.reactors['RX-02A'].notes = document.getElementById('handover-notes-rx2').value;

    return d;
  },

  saveCurrentSheet() {
    const d = this.collectSheet();
    Store.saveSheet(this.currentDate, this.currentShift, d);
    this.showToast('保存しました');
    this.renderDateList();
  },

  autoSave() {
    const d = this.collectSheet();
    Store.saveSheet(this.currentDate, this.currentShift, d);
    // Firebase同期
    FireSync.saveSheet(this.currentDate, this.currentShift, d);
    // Update sync indicator briefly
    const badge = document.getElementById('sync-status');
    badge.style.color = '#16a34a';
    setTimeout(() => { badge.style.color = ''; }, 1000);
  },

  // ---- Reactor Entries ----
  renderEntries() {
    const container = document.getElementById('record-entries');
    container.innerHTML = '';
    const rx = this._currentData?.reactors?.[this.currentReactor];
    const entries = rx?.entries || [];

    if (entries.length === 0) {
      container.innerHTML = '<div class="empty-msg">実績なし — 下の＋ボタンで追加</div>';
      return;
    }

    entries.forEach((entry, idx) => {
      const card = document.createElement('div');
      card.className = 'entry-card';
      card.innerHTML = `
        <div class="entry-header">
          <strong>${this.esc(entry.title || '作業')}</strong>
          <span class="entry-time">${entry.start || ''} ～ ${entry.end || ''}</span>
        </div>
        <div class="entry-meta">
          ${entry.catalyst ? `<span class="entry-tag">${entry.catalyst}</span>` : ''}
          ${entry.fcCount ? `<span>${entry.fcCount}/${entry.fcTotal || '?'} FC</span>` : ''}
          ${entry.level ? `<span>Ⓛ ${entry.level}mm</span>` : ''}
        </div>
        ${entry.note ? `<div class="entry-note">${this.esc(entry.note)}</div>` : ''}
        <div class="entry-actions">
          <button class="btn-edit-entry" data-idx="${idx}">編集</button>
          <button class="btn-delete-entry" data-idx="${idx}">削除</button>
        </div>
      `;
      container.appendChild(card);
    });

    container.querySelectorAll('.btn-edit-entry').forEach(btn => {
      btn.addEventListener('click', () => this.openEntryModal(parseInt(btn.dataset.idx)));
    });
    container.querySelectorAll('.btn-delete-entry').forEach(btn => {
      btn.addEventListener('click', () => this.deleteEntry(parseInt(btn.dataset.idx)));
    });
  },

  openEntryModal(idx) {
    this._editingEntryIdx = idx !== undefined ? idx : -1;
    const modal = document.getElementById('modal-entry');

    // Reset
    document.getElementById('entry-title').value = '';
    document.getElementById('entry-catalyst').value = '';
    document.getElementById('entry-start').value = '';
    document.getElementById('entry-end').value = '';
    document.getElementById('entry-fc-count').value = '';
    document.getElementById('entry-fc-total').value = '';
    document.getElementById('entry-level').value = '';
    document.getElementById('entry-note').value = '';

    if (idx !== undefined && idx >= 0) {
      const entries = this._currentData?.reactors?.[this.currentReactor]?.entries || [];
      const e = entries[idx];
      if (e) {
        document.getElementById('entry-title').value = e.title || '';
        document.getElementById('entry-catalyst').value = e.catalyst || '';
        document.getElementById('entry-start').value = e.start || '';
        document.getElementById('entry-end').value = e.end || '';
        document.getElementById('entry-fc-count').value = e.fcCount || '';
        document.getElementById('entry-fc-total').value = e.fcTotal || '';
        document.getElementById('entry-level').value = e.level || '';
        document.getElementById('entry-note').value = e.note || '';
      }
    }

    modal.classList.remove('hidden');
  },

  closeEntryModal() {
    document.getElementById('modal-entry').classList.add('hidden');
  },

  saveEntry() {
    const entry = {
      title: document.getElementById('entry-title').value.trim(),
      catalyst: document.getElementById('entry-catalyst').value,
      start: document.getElementById('entry-start').value,
      end: document.getElementById('entry-end').value,
      fcCount: document.getElementById('entry-fc-count').value,
      fcTotal: document.getElementById('entry-fc-total').value,
      level: document.getElementById('entry-level').value,
      note: document.getElementById('entry-note').value.trim()
    };

    if (!entry.title) { this.showToast('作業内容を入力してください'); return; }

    if (!this._currentData.reactors) {
      this._currentData.reactors = { 'RX-01A': { entries: [], notes: '' }, 'RX-02A': { entries: [], notes: '' } };
    }
    const rx = this._currentData.reactors[this.currentReactor];
    if (!rx.entries) rx.entries = [];

    if (this._editingEntryIdx >= 0) {
      rx.entries[this._editingEntryIdx] = entry;
    } else {
      rx.entries.push(entry);
    }

    this.closeEntryModal();
    this.renderEntries();
    this.autoSave();
    this.showToast('実績を保存しました');
  },

  // 作業項目チェック → 実績を自動作成（モーダルなし）
  createEntryFromWorkItem(itemName) {
    const defaults = (typeof WORK_ITEM_DEFAULTS !== 'undefined') ? WORK_ITEM_DEFAULTS[itemName] : null;

    // 現在時刻
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');

    const entry = {
      title: itemName,
      catalyst: (defaults && defaults.catalyst) ? defaults.catalyst : '',
      start: `${hh}:${mm}`,
      end: '',
      fcCount: '',
      fcTotal: '',
      level: '',
      note: '',
      _fromWorkItem: true  // 作業項目から自動生成されたことを示すフラグ
    };

    // リアクターにエントリー追加
    if (!this._currentData.reactors) {
      this._currentData.reactors = { 'RX-01A': { entries: [], notes: '' }, 'RX-02A': { entries: [], notes: '' } };
    }
    const rx = this._currentData.reactors[this.currentReactor];
    if (!rx.entries) rx.entries = [];
    rx.entries.push(entry);
    this.renderEntries();
  },

  // 作業項目チェック解除 → 対応する実績を削除
  removeEntryFromWorkItem(itemName) {
    const rx = this._currentData?.reactors?.[this.currentReactor];
    if (!rx || !rx.entries) return;
    // 同じタイトルで自動生成されたエントリーを削除（最後に追加されたものから）
    for (let i = rx.entries.length - 1; i >= 0; i--) {
      if (rx.entries[i].title === itemName && rx.entries[i]._fromWorkItem) {
        rx.entries.splice(i, 1);
        break;
      }
    }
    this.renderEntries();
  },

  deleteEntry(idx) {
    if (!confirm('この実績を削除しますか？')) return;
    const rx = this._currentData.reactors[this.currentReactor];
    rx.entries.splice(idx, 1);
    this.renderEntries();
    this.autoSave();
  },

  // ---- Work Item Checklist ----
  renderWorkItems() {
    const panel = document.getElementById('work-items-panel');
    panel.innerHTML = '';

    Object.entries(SENDAI_WORK_ITEMS).forEach(([catKey, items]) => {
      const section = document.createElement('div');
      section.className = 'work-cat-section';

      const header = document.createElement('div');
      header.className = 'work-cat-header';
      header.textContent = WORK_CATEGORY_LABELS[catKey];
      header.addEventListener('click', () => {
        section.classList.toggle('collapsed');
      });
      section.appendChild(header);

      const list = document.createElement('div');
      list.className = 'work-cat-list';
      items.forEach(item => {
        const row = document.createElement('label');
        row.className = 'work-check-row';
        row.innerHTML = `<input type="checkbox" class="work-check" data-item="${catKey}:${item}" data-name="${item}"><span>${item}</span>`;
        row.querySelector('input').addEventListener('change', (e) => {
          if (e.target.checked) {
            this.createEntryFromWorkItem(item);
          } else {
            this.removeEntryFromWorkItem(item);
          }
          this.autoSave();
        });
        list.appendChild(row);
      });
      section.appendChild(list);
      panel.appendChild(section);
    });
  },

  restoreWorkChecks() {
    const checks = this._currentData?.workChecks || {};
    document.querySelectorAll('.work-check').forEach(cb => {
      cb.checked = !!checks[cb.dataset.item];
    });
  },

  // ---- Staff Management ----
  renderStaffSelect() {
    const select = document.getElementById('supervisor');
    const staff = Store.getStaff();
    select.innerHTML = '<option value="">--</option>';
    staff.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });
    this.renderStaffList();
  },

  renderStaffList() {
    const list = document.getElementById('staff-list');
    const staff = Store.getStaff();
    list.innerHTML = '';
    staff.forEach((name, idx) => {
      const row = document.createElement('div');
      row.className = 'staff-row';
      row.innerHTML = `<span>${this.esc(name)}</span><button class="btn-delete-staff" data-idx="${idx}">✕</button>`;
      row.querySelector('button').addEventListener('click', () => {
        const s = Store.getStaff();
        s.splice(idx, 1);
        Store.saveStaff(s);
        this.renderStaffSelect();
      });
      list.appendChild(row);
    });
  },

  addStaff() {
    const input = document.getElementById('staff-new');
    const name = input.value.trim();
    if (!name) return;
    const staff = Store.getStaff();
    if (!staff.includes(name)) {
      staff.push(name);
      Store.saveStaff(staff);
    }
    input.value = '';
    this.renderStaffSelect();
  },

  // ---- Catalyst Options ----
  renderCatalystOptions() {
    const select = document.getElementById('entry-catalyst');
    select.innerHTML = '<option value="">--</option>';
    CATALYST_NAMES.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });
  },

  // ---- Date List ----
  renderDateList() {
    const list = document.getElementById('date-list');
    const dates = Store.getDates();
    list.innerHTML = '';
    dates.slice(0, 30).forEach(k => {
      const parts = k.match(/^(\d{4}-\d{2}-\d{2})_(day|night)$/);
      if (!parts) return;
      const [, date, shift] = parts;
      const btn = document.createElement('button');
      btn.className = 'date-list-item';
      btn.textContent = `${date} ${shift === 'day' ? '昼勤' : '夜勤'}`;
      if (date === this.currentDate && shift === this.currentShift) btn.classList.add('active');
      btn.addEventListener('click', () => {
        this.currentDate = date;
        this.currentShift = shift;
        document.getElementById('date-select').value = date;
        document.querySelectorAll('.shift-btn').forEach(b => b.classList.toggle('active', b.dataset.shift === shift));
        this.loadSheet();
        this.toggleMenu(false);
      });
      list.appendChild(btn);
    });
  },

  // ---- Voice ----
  toggleVoice(targetId, btn) {
    if (this._voiceTarget === targetId) {
      VoiceInput.stop();
      this._voiceTarget = null;
      btn?.classList.remove('recording');
      return;
    }

    if (!VoiceInput.isSupported()) {
      this.showToast('音声入力非対応のブラウザです');
      return;
    }

    // Stop previous
    if (this._voiceTarget) {
      VoiceInput.stop();
      document.querySelectorAll('.btn-voice').forEach(b => b.classList.remove('recording'));
    }

    this._voiceTarget = targetId;
    btn?.classList.add('recording');

    VoiceInput.start({
      onResult: (text, isFinal) => {
        if (isFinal) {
          const el = document.getElementById(targetId);
          if (el) el.value += (el.value ? '\n' : '') + text;
        }
      },
      onError: (err) => {
        this.showToast('音声エラー: ' + err);
        this.toggleVoice(targetId, btn);
      },
      onEnd: () => {
        if (this._voiceTarget === targetId) {
          setTimeout(() => { if (this._voiceTarget === targetId) VoiceInput.start(); }, 500);
        }
      }
    });
  },

  // ---- Print A4 (引継帳フォーマット) ----
  printA4() {
    this.collectSheet();
    const d = this._currentData;
    const shiftLabel = d.shift === 'day' ? '昼勤' : '夜勤';
    const projName = Store.getSetting('projectName', '仙台RDSリアクター触媒交換工事');

    // Build work check items
    let workCheckRows = '';
    Object.entries(SENDAI_WORK_ITEMS).forEach(([catKey, items]) => {
      items.forEach(item => {
        const checked = d.workChecks?.[`${catKey}:${item}`] ? '■' : '□';
        workCheckRows += `<tr><td class="chk">${checked}</td><td>${item}</td></tr>`;
      });
    });

    // Build reactor entries
    const buildRxHtml = (rxName) => {
      const rx = d.reactors?.[rxName] || { entries: [], notes: '' };
      let html = '';
      rx.entries.forEach(e => {
        html += `<tr>
          <td>${e.title || ''}</td>
          <td>${e.start || ''} ～ ${e.end || ''}</td>
          <td>${e.fcCount || ''}${e.fcTotal ? '/' + e.fcTotal + ' FC' : ''}</td>
          <td>${e.level ? 'Ⓛ' + e.level + 'mm' : ''}</td>
          <td>${e.note || ''}</td>
        </tr>`;
      });
      if (rx.entries.length === 0) html = '<tr><td colspan="5" style="text-align:center;color:#999">—</td></tr>';
      return html;
    };

    // WBGT rows
    const wb = d.wbgt || [{}, {}, {}];
    let wbgtRows = '';
    for (let i = 0; i < 3; i++) {
      wbgtRows += `<tr><td>${i + 1}回目</td><td>${wb[i]?.temp || ''}</td><td>${wb[i]?.humidity || ''}</td><td>${wb[i]?.wbgt || ''}</td></tr>`;
    }

    const printHtml = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<title>${projName} ${d.date} ${shiftLabel}</title>
<style>
  @page { size: A4 portrait; margin: 8mm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "MS Gothic","Noto Sans JP",sans-serif; font-size: 8pt; line-height: 1.3; }
  h1 { font-size: 11pt; text-align: center; margin-bottom: 4pt; border-bottom: 2px solid #000; padding-bottom: 2pt; }
  .meta { display: flex; justify-content: space-between; margin-bottom: 4pt; font-size: 8pt; }
  .meta span { margin-right: 12pt; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 4pt; }
  th, td { border: 1px solid #333; padding: 2pt 4pt; font-size: 7.5pt; vertical-align: top; }
  th { background: #e8e8e8; font-weight: bold; text-align: center; }
  .rx-title { background: #d0d0d0; font-weight: bold; font-size: 9pt; text-align: center; }
  .section-title { background: #f0f0f0; font-weight: bold; font-size: 8pt; }
  .chk { text-align: center; width: 20pt; }
  .two-col { display: flex; gap: 4pt; }
  .two-col > div { flex: 1; }
  .notes-box { min-height: 30pt; white-space: pre-wrap; }
</style>
</head><body>
<h1>${projName}</h1>
<div class="meta">
  <span><b>＜${shiftLabel}＞</b></span>
  <span>天候：${d.weather || '—'}</span>
  <span>日付：${d.date || ''}</span>
  <span>担当：${d.supervisor || ''}</span>
</div>

<div class="two-col">
  <div>
    <table>
      <tr><th class="rx-title" colspan="5">RX-01A 実績</th></tr>
      <tr><th>作業内容</th><th>時間</th><th>FC</th><th>レベル</th><th>備考</th></tr>
      ${buildRxHtml('RX-01A')}
    </table>
  </div>
  <div>
    <table>
      <tr><th class="rx-title" colspan="5">RX-02A 実績</th></tr>
      <tr><th>作業内容</th><th>時間</th><th>FC</th><th>レベル</th><th>備考</th></tr>
      ${buildRxHtml('RX-02A')}
    </table>
  </div>
</div>

<table>
  <tr><th class="section-title" colspan="6">抜出/充填 実績</th></tr>
  <tr>
    <th>時間</th><td>${d.stats?.nukiStart || ''} ～ ${d.stats?.nukiEnd || ''}</td>
    <th>FC</th><td>${d.stats?.nukiCount || ''}/${d.stats?.nukiTotal || ''} FC</td>
    <th>Ⓛ</th><td>${d.stats?.level || ''} mm</td>
  </tr>
  <tr>
    <th>作業時間</th><td>${d.stats?.workStart || ''} ～ ${d.stats?.workEnd || ''}</td>
    <th>触媒温度</th><td>${d.stats?.catalystTemp || ''} ℃</td>
    <th>ドライアイス</th><td>${d.stats?.dryIce || ''} kg</td>
  </tr>
</table>

<table>
  <tr><th class="section-title" colspan="4">客先立会い</th></tr>
  <tr><th>設備検査</th><td>${d.inspection?.equipment || ''}</td><th>製油</th><td>${d.inspection?.seiyu || ''}</td></tr>
  <tr><th>GM承認</th><td>${d.inspection?.gm || ''}</td><th>自衛防</th><td>${d.inspection?.jieiho || ''}</td></tr>
</table>

<div class="two-col">
  <div>
    <table>
      <tr><th class="section-title" colspan="4">WBGT測定</th></tr>
      <tr><th></th><th>温度</th><th>湿度</th><th>WBGT</th></tr>
      ${wbgtRows}
    </table>
  </div>
  <div>
    <table>
      <tr><th class="section-title" colspan="2">引継ぎ事項</th></tr>
      <tr><th>RX-01A</th><td class="notes-box">${this.esc(d.reactors?.['RX-01A']?.notes || '')}</td></tr>
      <tr><th>RX-02A</th><td class="notes-box">${this.esc(d.reactors?.['RX-02A']?.notes || '')}</td></tr>
    </table>
  </div>
</div>

</body></html>`;

    const w = window.open('', '_blank');
    w.document.write(printHtml);
    w.document.close();
    setTimeout(() => w.print(), 400);
  },

  // ---- Export All PDF ----
  exportAllPDF() {
    const dates = Store.getDates();
    if (dates.length === 0) { this.showToast('データがありません'); return; }

    // Open all sheets in one print window
    let allHtml = '';
    dates.forEach(k => {
      const data = Store.getSheet(k.substring(0, 10), k.substring(11));
      if (data) {
        this._currentData = data;
        // We'll collect a simplified version
        allHtml += `<div style="page-break-after:always;">`;
        allHtml += `<h2>${data.date} ${data.shift === 'day' ? '昼勤' : '夜勤'}</h2>`;
        allHtml += `<p>天候: ${data.weather || '—'} / 担当: ${data.supervisor || '—'}</p>`;

        REACTORS.forEach(rx => {
          const entries = data.reactors?.[rx]?.entries || [];
          if (entries.length > 0) {
            allHtml += `<h3>${rx}</h3><table border="1" cellpadding="3" style="border-collapse:collapse;width:100%;font-size:9pt;">`;
            allHtml += '<tr><th>作業</th><th>時間</th><th>FC</th><th>備考</th></tr>';
            entries.forEach(e => {
              allHtml += `<tr><td>${e.title || ''}</td><td>${e.start || ''}～${e.end || ''}</td><td>${e.fcCount || ''}/${e.fcTotal || ''}</td><td>${e.note || ''}</td></tr>`;
            });
            allHtml += '</table>';
          }
          const notes = data.reactors?.[rx]?.notes;
          if (notes) allHtml += `<p><b>引継ぎ:</b> ${this.esc(notes)}</p>`;
        });
        allHtml += '</div>';
      }
    });

    // Restore current
    this.loadSheet();

    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>全日分引継帳</title>
    <style>@page{size:A4;margin:10mm}body{font-family:"MS Gothic","Noto Sans JP",sans-serif;font-size:9pt}h2{border-bottom:1px solid #000}table{margin:4pt 0}</style>
    </head><body>${allHtml}</body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 400);
  },

  // ---- Import / Export ----
  exportJSON() {
    const json = Store.exportAll();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `sendai_rds_backup_${todayStr()}.json`; a.click();
    URL.revokeObjectURL(url);
    this.showToast('バックアップをダウンロードしました');
  },

  importJSON(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const count = Store.importAll(reader.result);
        this.loadSheet();
        this.renderStaffSelect();
        this.showToast(`${count}件のデータをインポートしました`);
      } catch (err) {
        this.showToast('インポートエラー: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  },

  // ---- Firebase Config ----
  loadFirebaseConfigUI() {
    const config = FireSync.getConfig();
    if (config) {
      document.getElementById('fb-apiKey').value = config.apiKey || '';
      document.getElementById('fb-projectId').value = config.projectId || '';
    }
  },

  saveFirebaseConfig() {
    const apiKey = document.getElementById('fb-apiKey').value.trim();
    const projectId = document.getElementById('fb-projectId').value.trim();
    if (!apiKey || !projectId) {
      this.showToast('API KeyとProject IDを入力してください');
      return;
    }
    FireSync.saveConfig({ apiKey, authDomain: projectId + '.firebaseapp.com', projectId });
    localStorage.setItem('firebase_project_id', projectId);
    this.showToast('Firebase設定を保存しました。リロードで反映されます。');
  },

  async uploadToFirebase() {
    if (!FireSync.isEnabled()) {
      this.showToast('Firebase未接続です。設定を確認してください');
      return;
    }
    try {
      const count = await FireSync.uploadAll();
      this.showToast(`${count}件のデータをFirebaseに送信しました`);
    } catch (e) {
      this.showToast('送信エラー: ' + e.message);
    }
  },

  // ---- Helpers ----
  toggleMenu(show) { document.getElementById('side-menu').classList.toggle('hidden', !show); },
  checkOnline() {
    const online = navigator.onLine;
    document.getElementById('offline-banner').classList.toggle('hidden', online);
    document.getElementById('sync-status').style.color = online ? '#16a34a' : '#d97706';
    document.getElementById('sync-status').title = online ? 'オンライン' : 'オフライン';
  },
  showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.remove('hidden'); t.classList.add('show');
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.classList.add('hidden'), 300); }, 2000);
  },
  esc(str) { const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML; }
};

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => App.init());

// ---- Service Worker ----
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
