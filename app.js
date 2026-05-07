/* ========================================
   仙台RDS 引継帳 — App Logic
   ======================================== */
'use strict';

// ---- Utility ----
function todayStr() { return new Date().toLocaleDateString('sv-SE'); }
function nowISO() { return new Date().toISOString(); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// シート全体の差分イベント配列を返す (entries は別途記録するため除外)
function diffSheet(oldData, newData) {
  const events = [];
  const date = newData.date;
  const shift = newData.shift;
  if (!oldData) {
    events.push({ action: 'sheet_created', date, shift, sheetId: `${date}_${shift}` });
    return events;
  }
  const cmp = (path, oldVal, newVal) => {
    const o = oldVal == null ? '' : String(oldVal);
    const n = newVal == null ? '' : String(newVal);
    if (o !== n) events.push({ action: 'field_change', date, shift, sheetId: `${date}_${shift}`, field: path, before: o, after: n });
  };
  ['weather', 'supervisor'].forEach(k => cmp(k, oldData[k], newData[k]));
  const statKeys = new Set([...Object.keys(oldData.stats || {}), ...Object.keys(newData.stats || {})]);
  statKeys.forEach(k => cmp(`stats.${k}`, oldData.stats?.[k], newData.stats?.[k]));
  const inspKeys = new Set([...Object.keys(oldData.inspection || {}), ...Object.keys(newData.inspection || {})]);
  inspKeys.forEach(k => cmp(`inspection.${k}`, oldData.inspection?.[k], newData.inspection?.[k]));
  const wbgtLen = Math.max((oldData.wbgt || []).length, (newData.wbgt || []).length);
  for (let i = 0; i < wbgtLen; i++) {
    ['temp', 'humidity', 'wbgt'].forEach(k => cmp(`wbgt[${i + 1}].${k}`, oldData.wbgt?.[i]?.[k], newData.wbgt?.[i]?.[k]));
  }
  const rxKeys = new Set([...Object.keys(oldData.reactors || {}), ...Object.keys(newData.reactors || {})]);
  rxKeys.forEach(rxKey => cmp(`${rxKey}.notes`, oldData.reactors?.[rxKey]?.notes, newData.reactors?.[rxKey]?.notes));
  const oldChecks = oldData.workChecks || {}, newChecks = newData.workChecks || {};
  const allChecks = new Set([...Object.keys(oldChecks), ...Object.keys(newChecks)]);
  allChecks.forEach(k => {
    const o = oldChecks[k] ? '✓' : '', n = newChecks[k] ? '✓' : '';
    if (o !== n) events.push({ action: 'work_check', date, shift, sheetId: `${date}_${shift}`, field: `workCheck:${k}`, before: o, after: n });
  });
  return events;
}

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

// ---- History (audit log) — ローカルキャッシュ + Firestore audit コレクションへ書込み ----
const History = {
  MAX_LOCAL: 1000,

  _all() { return Store._get('hiki_history', []); },
  _save(arr) { Store._set('hiki_history', arr); },

  record(events) {
    if (!Array.isArray(events)) events = [events];
    if (events.length === 0) return;
    const all = this._all();
    events.forEach(ev => {
      const entry = {
        id: 'h_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        ts: nowISO(),
        userName: (typeof Auth !== 'undefined' && Auth.getMemberName) ? Auth.getMemberName() : '(未ログイン)',
        userId: (typeof Auth !== 'undefined' && Auth.getUid) ? Auth.getUid() : null,
        ...ev
      };
      all.push(entry);
      if (typeof FireSync !== 'undefined' && FireSync.isEnabled && FireSync.isEnabled()) {
        FireSync.writeAuditDetail(ev).catch(() => {});
      }
    });
    if (all.length > this.MAX_LOCAL) all.splice(0, all.length - this.MAX_LOCAL);
    this._save(all);
  },

  getAll() { return this._all().slice().reverse(); },
  clear() { this._save([]); }
};

// ---- Search (全シート横断テキスト検索) ----
const Search = {
  query(q) {
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return [];
    const results = [];
    const dates = Store.getDates();
    dates.forEach(key => {
      const sheet = Store._get(`hiki_${key}`, null);
      if (!sheet) return;
      const matches = [];
      const hit = (label, text) => {
        const s = String(text == null ? '' : text);
        if (s && s.toLowerCase().includes(needle)) matches.push({ label, text: s });
      };
      hit('担当', sheet.supervisor);
      hit('天候', sheet.weather);
      const insp = sheet.inspection || {};
      hit('立会(設備検査)', insp.equipment);
      hit('立会(製油)', insp.seiyu);
      hit('立会(GM承認)', insp.gm);
      hit('立会(自衛防)', insp.jieiho);
      Object.entries(sheet.reactors || {}).forEach(([rxKey, rx]) => {
        hit(`${rxKey} 引継ぎ事項`, rx.notes);
        (rx.entries || []).forEach((e, idx) => {
          const tag = `${rxKey} 実績#${idx + 1}`;
          hit(`${tag} 作業内容`, e.title);
          hit(`${tag} 触媒`, e.catalyst);
          hit(`${tag} 備考`, e.note);
        });
      });
      if (matches.length > 0) {
        const date = key.substring(0, 10);
        const shift = key.substring(11);
        results.push({ date, shift, key, matches });
      }
    });
    results.sort((a, b) => b.key.localeCompare(a.key));
    return results;
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
    // 起動時はログイン前提（アプリ本体を隠す）
    document.body.classList.add('not-authed');

    // ログイン画面のイベント
    this.bindLoginEvents();

    // 認証初期化
    Auth.init((user, member) => this.onAuthChange(user, member));
  },

  // ---- 認証 ----
  bindLoginEvents() {
    document.getElementById('btn-login').addEventListener('click', () => this.doLogin());
    document.getElementById('login-passcode').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('login-name').focus();
    });
    document.getElementById('login-name').addEventListener('keydown', e => {
      if (e.key === 'Enter') this.doLogin();
    });
  },

  async onAuthChange(user, member) {
    const loginScreen = document.getElementById('login-screen');

    if (!user || !member) {
      // 未ログイン or メンバー未登録 → ログイン画面
      document.body.classList.add('not-authed');
      loginScreen.classList.remove('hidden');
      return;
    }

    // ログイン＆メンバー確認OK → アプリ起動
    document.body.classList.remove('not-authed');
    loginScreen.classList.add('hidden');

    if (!this._appStarted) {
      this._appStarted = true;
      await this._startApp();
    }
  },

  async _startApp() {
    // Theme
    if (Store.getSetting('darkMode', false)) {
      document.documentElement.setAttribute('data-theme', 'dark');
      document.getElementById('toggle-dark').checked = true;
    }

    document.getElementById('date-select').value = this.currentDate;
    this.bindEvents();

    // ログインユーザーを担当者リストに自動追加
    const myName = Auth.getMemberName();
    if (myName && myName !== '不明') {
      const staff = Store.getStaff();
      if (!staff.includes(myName)) {
        staff.push(myName);
        Store.saveStaff(staff);
      }
    }

    this.renderStaffSelect();

    // 担当者をログインユーザーで自動選択（未選択の場合のみ）
    const supervisorEl = document.getElementById('supervisor');
    if (!supervisorEl.value && myName) {
      supervisorEl.value = myName;
    }

    this.renderWorkItems();
    this.renderCatalystOptions();
    this.loadSheet();
    this.checkOnline();

    // Firestore同期を初期化（認証済み前提）
    FireSync.init((date, shift, remoteData) => {
      // リモート更新は手動リロードで反映（ループ防止）
      console.log('[FireSync] リモート更新検知（自動反映OFF）', date, shift);
    }).then(ok => {
      if (ok) {
        this.showToast('接続OK');
        FireSync.listenSheet(this.currentDate, this.currentShift);
      }
    });
  },

  async doLogin() {
    const passcode = document.getElementById('login-passcode').value.trim();
    const name = document.getElementById('login-name').value.trim();

    if (!passcode) { this._showLoginError('パスコードを入力してください'); return; }
    if (!name) { this._showLoginError('名前を入力してください'); return; }
    if (!Auth.checkPasscode(passcode)) { this._showLoginError('パスコードが違います'); return; }

    this._showLoginLoading(true);
    this._clearLoginError();

    try {
      // 匿名ログイン
      await Auth.signInAnonymously();

      // 最初の登録者は管理者、2人目以降は作業者
      const db = firebase.firestore();
      const membersSnap = await db.collection('projects').doc(HIKI_PROJECT_ID)
        .collection('members').limit(1).get();
      const role = membersSnap.empty ? 'admin' : 'worker';

      // メンバー登録
      await Auth.registerMember(name, role);

      // 画面更新（onAuthChange が呼ばれる）
      this.onAuthChange(Auth.getUser(), Auth.getMember());
    } catch (e) {
      this._showLoginError('ログインエラー: ' + e.message);
    } finally {
      this._showLoginLoading(false);
    }
  },

  _showLoginError(msg) {
    const el = document.getElementById('login-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  },

  _clearLoginError() {
    document.getElementById('login-error').classList.add('hidden');
  },

  _showLoginLoading(show) {
    document.getElementById('login-loading').classList.toggle('hidden', !show);
  },

  // ---- Events ----
  bindEvents() {
    // Date
    document.getElementById('date-select').addEventListener('change', e => {
      this.currentDate = e.target.value;
      this.loadSheet();
      FireSync.listenSheet(this.currentDate, this.currentShift);
    });

    // Shift toggle
    document.querySelectorAll('.shift-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.shift-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentShift = btn.dataset.shift;
        this.loadSheet();
        FireSync.listenSheet(this.currentDate, this.currentShift);
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
    document.getElementById('btn-export-csv').addEventListener('click', () => this.exportCSV());

    // Search
    document.getElementById('btn-search').addEventListener('click', () => this.openSearchModal());
    document.getElementById('btn-search-close').addEventListener('click', () => this.closeSearchModal());
    document.getElementById('search-input').addEventListener('input', () => this.runSearch());

    // History
    document.getElementById('btn-history').addEventListener('click', () => { this.toggleMenu(false); this.openHistoryModal(); });
    document.getElementById('btn-history-close').addEventListener('click', () => this.closeHistoryModal());

    // Account
    document.getElementById('btn-signout').addEventListener('click', () => this.signOut());
    document.getElementById('btn-fb-upload').addEventListener('click', () => this.uploadToFirebase());
    this._updateAccountInfo();

    // Project name
    document.getElementById('setting-project-name').addEventListener('change', e => {
      Store.setSetting('projectName', e.target.value);
      document.getElementById('header-title').textContent = e.target.value;
    });

    // Time slot add button
    document.getElementById('btn-add-time-slot').addEventListener('click', () => this._addTimeSlot());

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
  _suppressSync: false,

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
    const oldData = Store.getSheet(this.currentDate, this.currentShift);
    const d = this.collectSheet();
    const events = diffSheet(oldData, d);
    if (events.length > 0) History.record(events);
    Store.saveSheet(this.currentDate, this.currentShift, d);
    if (!this._suppressSync) {
      FireSync.saveSheet(this.currentDate, this.currentShift, d);
    }
    this.showToast('保存しました');
    this.renderDateList();
  },

  autoSave() {
    const oldData = Store.getSheet(this.currentDate, this.currentShift);
    const d = this.collectSheet();
    const events = diffSheet(oldData, d);
    if (events.length > 0) History.record(events);
    Store.saveSheet(this.currentDate, this.currentShift, d);
    if (!this._suppressSync) {
      FireSync.saveSheet(this.currentDate, this.currentShift, d);
    }
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
      // 時間帯の表示（複数対応）
      const times = this._getEntryTimes(entry);
      const timesHtml = times.map(t => `<span>${t.start || '?'} ～ ${t.end || ''}</span>`).join('');
      card.innerHTML = `
        <div class="entry-header">
          <strong>${this.esc(entry.title || '作業')}</strong>
          <div class="entry-times">${timesHtml}</div>
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
    document.getElementById('entry-fc-count').value = '';
    document.getElementById('entry-fc-total').value = '';
    document.getElementById('entry-level').value = '';
    document.getElementById('entry-note').value = '';

    // 作業項目タブを初期化
    this._renderWorkTabs();

    if (idx !== undefined && idx >= 0) {
      const entries = this._currentData?.reactors?.[this.currentReactor]?.entries || [];
      const e = entries[idx];
      if (e) {
        document.getElementById('entry-title').value = e.title || '';
        document.getElementById('entry-catalyst').value = e.catalyst || '';
        document.getElementById('entry-fc-count').value = e.fcCount || '';
        document.getElementById('entry-fc-total').value = e.fcTotal || '';
        document.getElementById('entry-level').value = e.level || '';
        document.getElementById('entry-note').value = e.note || '';
        const times = this._getEntryTimes(e);
        this._renderTimeSlots(times);
      } else {
        this._renderTimeSlots([{ start: '', end: '' }]);
      }
    } else {
      this._renderTimeSlots([{ start: '', end: '' }]);
    }

    modal.classList.remove('hidden');
  },

  _renderWorkTabs() {
    const tabsEl = document.getElementById('entry-work-tabs');
    const itemsEl = document.getElementById('entry-work-items');
    tabsEl.innerHTML = '';
    itemsEl.innerHTML = '';
    itemsEl.classList.remove('open');

    Object.entries(SENDAI_WORK_ITEMS).forEach(([catKey, items]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ewt-btn';
      btn.textContent = WORK_CATEGORY_LABELS[catKey];
      btn.addEventListener('click', () => {
        tabsEl.querySelectorAll('.ewt-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._renderWorkItemList(catKey, items);
      });
      tabsEl.appendChild(btn);
    });
  },

  _renderWorkItemList(catKey, items) {
    const itemsEl = document.getElementById('entry-work-items');
    itemsEl.innerHTML = '';
    itemsEl.classList.add('open');

    items.forEach(name => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ewi-btn';
      btn.textContent = name;
      btn.addEventListener('click', () => {
        document.getElementById('entry-title').value = name;
        itemsEl.classList.remove('open');
        document.getElementById('entry-work-tabs').querySelectorAll('.ewt-btn').forEach(b => b.classList.remove('active'));
        // デフォルト値を自動適用
        const defaults = (typeof WORK_ITEM_DEFAULTS !== 'undefined') ? WORK_ITEM_DEFAULTS[name] : null;
        if (defaults && defaults.catalyst) {
          document.getElementById('entry-catalyst').value = defaults.catalyst;
        }
      });
      itemsEl.appendChild(btn);
    });
  },

  closeEntryModal() {
    document.getElementById('modal-entry').classList.add('hidden');
  },

  saveEntry() {
    // 時間スロットを収集
    const times = [];
    document.querySelectorAll('#entry-time-slots .time-row').forEach(row => {
      const start = row.querySelector('.slot-start').value;
      const end = row.querySelector('.slot-end').value;
      if (start || end) times.push({ start, end });
    });

    const entry = {
      title: document.getElementById('entry-title').value.trim(),
      catalyst: document.getElementById('entry-catalyst').value,
      times: times.length > 0 ? times : [{ start: '', end: '' }],
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

    const isEdit = this._editingEntryIdx >= 0;
    const beforeEntry = isEdit ? rx.entries[this._editingEntryIdx] : null;
    if (isEdit) {
      rx.entries[this._editingEntryIdx] = entry;
    } else {
      rx.entries.push(entry);
    }

    History.record({
      action: isEdit ? 'entry_updated' : 'entry_added',
      date: this.currentDate, shift: this.currentShift,
      sheetId: `${this.currentDate}_${this.currentShift}`,
      reactor: this.currentReactor,
      entry: { title: entry.title, catalyst: entry.catalyst, times: entry.times, fcCount: entry.fcCount, fcTotal: entry.fcTotal, level: entry.level, note: entry.note },
      ...(isEdit && beforeEntry ? { before: { title: beforeEntry.title, catalyst: beforeEntry.catalyst, times: beforeEntry.times, fcCount: beforeEntry.fcCount, fcTotal: beforeEntry.fcTotal, level: beforeEntry.level, note: beforeEntry.note } } : {})
    });

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
      times: [{ start: `${hh}:${mm}`, end: '' }],
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
    History.record({
      action: 'entry_added_from_work_item',
      date: this.currentDate, shift: this.currentShift,
      sheetId: `${this.currentDate}_${this.currentShift}`,
      reactor: this.currentReactor,
      entry: { title: entry.title, catalyst: entry.catalyst, times: entry.times }
    });
    this.renderEntries();
  },

  // 作業項目チェック解除 → 対応する実績を削除
  removeEntryFromWorkItem(itemName) {
    const rx = this._currentData?.reactors?.[this.currentReactor];
    if (!rx || !rx.entries) return;
    // 同じタイトルで自動生成されたエントリーを削除（最後に追加されたものから）
    for (let i = rx.entries.length - 1; i >= 0; i--) {
      if (rx.entries[i].title === itemName && rx.entries[i]._fromWorkItem) {
        const removed = rx.entries[i];
        rx.entries.splice(i, 1);
        History.record({
          action: 'entry_removed_from_work_item',
          date: this.currentDate, shift: this.currentShift,
          sheetId: `${this.currentDate}_${this.currentShift}`,
          reactor: this.currentReactor,
          entry: { title: removed.title }
        });
        break;
      }
    }
    this.renderEntries();
  },

  deleteEntry(idx) {
    if (!confirm('この実績を削除しますか？')) return;
    const rx = this._currentData.reactors[this.currentReactor];
    const removed = rx.entries[idx];
    rx.entries.splice(idx, 1);
    History.record({
      action: 'entry_deleted',
      date: this.currentDate, shift: this.currentShift,
      sheetId: `${this.currentDate}_${this.currentShift}`,
      reactor: this.currentReactor,
      entry: removed ? { title: removed.title, catalyst: removed.catalyst, times: removed.times, note: removed.note } : null
    });
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
        FireSync.listenSheet(this.currentDate, this.currentShift);
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

  // ---- Print A4 (引継帳フォーマット — Excel原紙準拠) ----
  // 1シフト=1ページ、RX-01A(左) / RX-02A(右) 横並び、リアクター図なし

  _printCSS() {
    return `
  /* A4横 固定レイアウト — 行数によらず同一フォーマットを維持 */
  @page { size: A4 landscape; margin: 5mm; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:287mm; height:200mm; }
  body { font-family:"MS Gothic","ＭＳ ゴシック","Noto Sans JP",monospace; font-size:7pt; line-height:1.3; overflow:hidden; }

  .page { width:100%; height:100%; display:flex; flex-direction:column; }
  .header { flex:0 0 auto; text-align:center; margin-bottom:2pt; }
  .header h1 { font-size:9pt; margin:0; }
  .header h2 { font-size:11pt; margin:0; font-weight:bold; }

  /* シフト情報行 */
  .shift-info { flex:0 0 auto; display:flex; justify-content:space-between; align-items:center;
    border:1pt solid #000; border-bottom:none; padding:2pt 6pt; font-size:8pt; }
  .shift-info .shift-name { font-weight:bold; font-size:10pt; }
  .shift-info-day { background:#e8e8e8; }
  .shift-info-night { background:#444; color:#fff; }

  /* メインテーブル: RX-01A(左) | RX-02A(右) */
  .main-table { display:flex; border:1.5pt solid #000; flex:1 1 0; min-height:0; overflow:hidden; }
  .rx-col { flex:1; display:flex; flex-direction:column; min-width:0; min-height:0; overflow:hidden; }
  .rx-col + .rx-col { border-left:1.5pt solid #000; }

  /* RX列ヘッダー */
  .rx-header { flex:0 0 auto; font-weight:bold; font-size:9pt; text-align:center;
    padding:2pt 0; border-bottom:1pt solid #000; background:#f0f0f0; }

  /* 実績エントリーエリア — 過剰行は overflow:hidden で切り捨て、レイアウト不変 */
  .rx-entries { flex:1; padding:2pt 3pt; overflow:hidden; min-height:0; display:flex; flex-direction:column; }

  /* 実績行: 高さを固定 (内容にかかわらず常に同じ罫線間隔) */
  .entry-row { flex:0 0 11pt; height:11pt; display:flex; border-bottom:0.5pt solid #ccc; align-items:baseline; padding:0.5pt 0; overflow:hidden; }
  .er-time { width:70pt; font-size:6.5pt; flex-shrink:0; white-space:nowrap; overflow:hidden; }
  .er-title { flex:1; font-size:7pt; font-weight:bold; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .er-meta { font-size:6pt; color:#333; padding-left:4pt; }
  .er-meta-line { flex:0 0 9pt; height:9pt; display:flex; gap:6pt; font-size:6pt; padding:0 0 0.5pt 70pt; border-bottom:0.5pt dotted #ddd; overflow:hidden; }
  .er-note { flex:0 0 9pt; height:9pt; font-size:6pt; color:#555; padding:0 0 0.5pt 70pt; border-bottom:0.5pt dotted #eee; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .entry-row.empty { border-bottom:0.5pt dotted #ddd; }

  /* 管理データ行（エントリー下部） */
  .rx-mgmt { border-top:1pt solid #000; padding:2pt 3pt; font-size:6.5pt; }
  .mgmt-grid { display:grid; grid-template-columns:1fr 1fr; gap:1pt 8pt; }
  .mgmt-item { display:flex; gap:2pt; }
  .mgmt-label { font-weight:bold; white-space:nowrap; }
  .mgmt-value { }

  /* 下部: WBGT + 引継ぎ */
  .bottom-area { display:flex; border:1.5pt solid #000; border-top:none; }
  .bottom-left { flex:1; border-right:1pt solid #000; padding:2pt 4pt; }
  .bottom-right { flex:2; padding:2pt 4pt; }

  .wbgt-title { font-weight:bold; font-size:7pt; margin-bottom:1pt; }
  .wbgt-table { width:100%; border-collapse:collapse; font-size:6.5pt; }
  .wbgt-table th { background:#f0f0f0; border:0.5pt solid #999; padding:1pt 3pt; font-weight:bold; text-align:center; }
  .wbgt-table td { border:0.5pt solid #ccc; padding:1pt 3pt; text-align:center; }

  .handover-title { font-weight:bold; font-size:7pt; margin-bottom:1pt; }
  .handover-box { display:flex; gap:6pt; }
  .handover-col { flex:1; }
  .handover-label { font-weight:bold; font-size:6.5pt; border-bottom:0.5pt solid #000; margin-bottom:1pt; }
  .handover-text { font-size:6.5pt; white-space:pre-wrap; word-break:break-all; min-height:20pt; }

  /* 立会い・検査行 */
  .inspection-row { display:flex; gap:8pt; font-size:6.5pt; padding:1pt 0; border-top:0.5pt solid #ccc; }
  .insp-item { display:flex; gap:2pt; }
  .insp-label { font-weight:bold; }`;
  },

  _buildEntryLines(shiftData, rxName) {
    const rx = shiftData?.reactors?.[rxName] || { entries: [], notes: '' };
    const entries = rx.entries || [];
    let html = '';
    entries.forEach(e => {
      const times = (e.times && e.times.length > 0) ? e.times : [{ start: e.start || '', end: e.end || '' }];
      const t0 = times[0] || {};
      const timeStr = (t0.start || '') + (t0.start || t0.end ? ' ～ ' : '') + (t0.end || '');
      html += `<div class="entry-row"><span class="er-time">${timeStr}</span><span class="er-title">${this.esc(e.title || '')}</span></div>`;
      const meta = [];
      if (e.catalyst) meta.push(`触媒: ${e.catalyst}`);
      if (e.fcCount) meta.push(`FC: ${e.fcCount}/${e.fcTotal||'?'}`);
      if (e.level) meta.push(`Ⓛ ${e.level}mm`);
      if (meta.length > 0) html += `<div class="er-meta-line">${meta.join('　')}</div>`;
      for (let ti = 1; ti < times.length; ti++) {
        const t = times[ti];
        const ts = (t.start || '') + (t.start || t.end ? ' ～ ' : '') + (t.end || '');
        html += `<div class="entry-row"><span class="er-time">${ts}</span><span class="er-title"></span></div>`;
      }
      if (e.note) html += `<div class="er-note">${this.esc(e.note)}</div>`;
    });
    // 実領域に対する行数 (entry-row=11pt + er-meta-line/er-note=9pt) を概算で埋める
    // .rx-entries 領域は約190pt → 11pt × 17行 が上限。安全のため18本で埋め、超過は overflow:hidden で切り捨て
    const minLines = 18;
    let usedLines = 0;
    entries.forEach(e => {
      const times = (e.times && e.times.length > 0) ? e.times : [{}];
      usedLines += times.length;
      const metaCount = (e.catalyst ? 1 : 0) + (e.fcCount ? 0 : 0) + (e.level ? 0 : 0);
      if (e.catalyst || e.fcCount || e.level) usedLines += 0.8;  // er-meta-line は9pt なので約0.8行分
      if (e.note) usedLines += 0.8;
    });
    for (let i = Math.ceil(usedLines); i < minLines; i++) html += '<div class="entry-row empty"></div>';
    return html;
  },

  _buildRxMgmt(shiftData, rxName) {
    const s = shiftData?.stats || {};
    const entries = shiftData?.reactors?.[rxName]?.entries || [];
    let lastLevel = '';
    entries.forEach(e => { if (e.level) lastLevel = e.level; });
    return `<div class="mgmt-grid">
      <div class="mgmt-item"><span class="mgmt-label">レベル:</span><span class="mgmt-value">${lastLevel ? lastLevel+' mm' : '―'}</span></div>
      <div class="mgmt-item"><span class="mgmt-label">触媒温度:</span><span class="mgmt-value">${s.catalystTemp ? s.catalystTemp+' ℃' : '―'}</span></div>
      <div class="mgmt-item"><span class="mgmt-label">ﾄﾞﾗｲｱｲｽ:</span><span class="mgmt-value">${s.dryIce ? s.dryIce+' kg' : '―'}</span></div>
      <div class="mgmt-item"><span class="mgmt-label">FC:</span><span class="mgmt-value">${s.nukiCount ? s.nukiCount+'/'+(s.nukiTotal||'?') : '―'}</span></div>
    </div>`;
  },

  _buildWbgtTable(shiftData) {
    const wb = shiftData?.wbgt || [{}, {}, {}];
    let html = `<table class="wbgt-table"><thead><tr><th></th><th>温度</th><th>湿度</th><th>WBGT</th></tr></thead><tbody>`;
    for (let i = 0; i < 3; i++) {
      html += `<tr><th>${i+1}回目</th><td>${wb[i]?.temp||''}</td><td>${wb[i]?.humidity||''}</td><td>${wb[i]?.wbgt||''}</td></tr>`;
    }
    html += '</tbody></table>';
    return html;
  },

  _buildShiftPageHtml(date, shiftData, shiftType) {
    const dateObj = new Date(date + 'T00:00:00');
    const weekDays = ['日','月','火','水','木','金','土'];
    const dateStr = `${dateObj.getMonth()+1}月　${dateObj.getDate()}日（${weekDays[dateObj.getDay()]}）`;
    const isDay = shiftType === 'day';
    const shiftLabel = isDay ? '昼　勤' : '夜　勤';
    const insp = shiftData?.inspection || {};

    return `
  <div class="header">
    <h1>ENEOS（株）仙台製油所</h1>
    <h2>RDS－RX－01＆02A　触媒交換工事実績表</h2>
  </div>
  <div class="shift-info ${isDay ? 'shift-info-day' : 'shift-info-night'}">
    <span class="shift-name">${shiftLabel}</span>
    <span>${dateStr}</span>
    <span>天候（${shiftData.weather||'　　'}）</span>
    <span>担当：${shiftData.supervisor||''}</span>
  </div>
  <div class="main-table">
    <div class="rx-col">
      <div class="rx-header">RX-01A</div>
      <div class="rx-entries">${this._buildEntryLines(shiftData, 'RX-01A')}</div>
      <div class="rx-mgmt">${this._buildRxMgmt(shiftData, 'RX-01A')}</div>
    </div>
    <div class="rx-col">
      <div class="rx-header">RX-02A</div>
      <div class="rx-entries">${this._buildEntryLines(shiftData, 'RX-02A')}</div>
      <div class="rx-mgmt">${this._buildRxMgmt(shiftData, 'RX-02A')}</div>
    </div>
  </div>
  <div class="bottom-area">
    <div class="bottom-left">
      <div class="wbgt-title">WBGT測定</div>
      ${this._buildWbgtTable(shiftData)}
      <div class="inspection-row">
        <div class="insp-item"><span class="insp-label">設備:</span><span>${insp.equipment||''}</span></div>
        <div class="insp-item"><span class="insp-label">製油:</span><span>${insp.seiyu||''}</span></div>
        <div class="insp-item"><span class="insp-label">GM:</span><span>${insp.gm||''}</span></div>
        <div class="insp-item"><span class="insp-label">自衛防:</span><span>${insp.jieiho||''}</span></div>
      </div>
    </div>
    <div class="bottom-right">
      <div class="handover-title">引継ぎ事項</div>
      <div class="handover-box">
        <div class="handover-col">
          <div class="handover-label">RX-01A</div>
          <div class="handover-text">${this.esc(shiftData?.reactors?.['RX-01A']?.notes || '')}</div>
        </div>
        <div class="handover-col">
          <div class="handover-label">RX-02A</div>
          <div class="handover-text">${this.esc(shiftData?.reactors?.['RX-02A']?.notes || '')}</div>
        </div>
      </div>
    </div>
  </div>`;
  },

  printA4() {
    this.collectSheet();
    const projName = Store.getSetting('projectName', '2026年仙台RDSリアクター触媒交換工事');
    const shiftData = Store.getSheet(this.currentDate, this.currentShift) || this._currentData;

    const printHtml = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<title>${projName} ${this.currentDate} ${this.currentShift === 'day' ? '昼勤' : '夜勤'}</title>
<style>${this._printCSS()}</style>
</head><body>
<div class="page">${this._buildShiftPageHtml(this.currentDate, shiftData, this.currentShift)}</div>
</body></html>`;

    const w = window.open('', '_blank');
    w.document.write(printHtml);
    w.document.close();
    setTimeout(() => w.print(), 400);
  },

  exportAllPDF() {
    const allKeys = Store.getDates();
    if (allKeys.length === 0) { this.showToast('データがありません'); return; }
    const projName = Store.getSetting('projectName', '2026年仙台RDSリアクター触媒交換工事');

    let pagesHtml = '';
    const sortedKeys = [...allKeys].sort();
    sortedKeys.forEach((k, i) => {
      const parts = k.match(/^(\d{4}-\d{2}-\d{2})_(day|night)$/);
      if (!parts) return;
      const [, date, shift] = parts;
      const shiftData = Store.getSheet(date, shift) || this.createEmptySheet();
      const pageBreak = i < sortedKeys.length - 1 ? 'page-break-after:always;' : '';
      pagesHtml += `<div class="page" style="${pageBreak}">${this._buildShiftPageHtml(date, shiftData, shift)}</div>`;
    });

    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>全日分実績表</title>
    <style>${this._printCSS()}</style></head><body>${pagesHtml}</body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 400);
  },

  // ---- CSV Export (実績エントリ単位、1行=1エントリ) ----
  exportCSV() {
    const headers = ['日付', 'シフト', '担当', '天候', 'リアクター', '作業内容', '触媒', '開始時刻', '終了時刻', 'FC数', 'FC合計', 'レベル(mm)', '備考'];
    const rows = [headers];
    const dates = Store.getDates();
    let entryCount = 0;
    dates.forEach(key => {
      const sheet = Store._get(`hiki_${key}`, null);
      if (!sheet) return;
      const date = key.substring(0, 10);
      const shiftLabel = key.endsWith('day') ? '昼勤' : '夜勤';
      const supervisor = sheet.supervisor || '';
      const weather = sheet.weather || '';
      Object.entries(sheet.reactors || {}).forEach(([rxKey, rx]) => {
        (rx.entries || []).forEach(e => {
          const times = (e.times && e.times.length > 0) ? e.times : [{ start: e.start || '', end: e.end || '' }];
          times.forEach(t => {
            rows.push([date, shiftLabel, supervisor, weather, rxKey, e.title || '', e.catalyst || '', t.start || '', t.end || '', e.fcCount || '', e.fcTotal || '', e.level || '', e.note || '']);
            entryCount++;
          });
        });
      });
    });
    if (entryCount === 0) { this.showToast('エクスポートする実績がありません'); return; }
    const csv = '﻿' + rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `sendai_rds_entries_${todayStr()}.csv`; a.click();
    URL.revokeObjectURL(url);
    this.showToast(`${entryCount}件の実績をCSV出力しました`);
  },

  // ---- Search Modal ----
  openSearchModal() {
    document.getElementById('search-input').value = '';
    document.getElementById('search-results').innerHTML = '<div class="empty-msg">キーワードを入力してください</div>';
    document.getElementById('modal-search').classList.remove('hidden');
    setTimeout(() => document.getElementById('search-input').focus(), 50);
  },
  closeSearchModal() { document.getElementById('modal-search').classList.add('hidden'); },
  runSearch() {
    const q = document.getElementById('search-input').value;
    const results = Search.query(q);
    const container = document.getElementById('search-results');
    if (!q.trim()) { container.innerHTML = '<div class="empty-msg">キーワードを入力してください</div>'; return; }
    if (results.length === 0) { container.innerHTML = '<div class="empty-msg">該当データなし</div>'; return; }
    container.innerHTML = results.map(r => {
      const shiftLabel = r.shift === 'day' ? '昼勤' : '夜勤';
      const matchHtml = r.matches.slice(0, 3).map(m => {
        return `<div class="search-match"><span class="search-tag">${this.esc(m.label)}</span><span class="search-snippet">${this.esc(this._snippet(m.text, q.trim()))}</span></div>`;
      }).join('');
      const more = r.matches.length > 3 ? `<div class="search-more">+ ${r.matches.length - 3}件</div>` : '';
      return `<div class="search-result" data-date="${r.date}" data-shift="${r.shift}"><div class="search-header"><strong>${r.date}</strong> <span class="shift-pill">${shiftLabel}</span></div>${matchHtml}${more}</div>`;
    }).join('');
    container.querySelectorAll('.search-result').forEach(el => {
      el.addEventListener('click', () => {
        this.currentDate = el.dataset.date;
        this.currentShift = el.dataset.shift;
        document.getElementById('date-select').value = this.currentDate;
        document.querySelectorAll('.shift-btn').forEach(b => b.classList.toggle('active', b.dataset.shift === this.currentShift));
        this.loadSheet();
        this.closeSearchModal();
      });
    });
  },
  _snippet(text, q) {
    const lo = text.toLowerCase().indexOf(q.toLowerCase());
    if (lo < 0) return text.length > 60 ? text.slice(0, 60) + '…' : text;
    const start = Math.max(0, lo - 20);
    const end = Math.min(text.length, lo + q.length + 30);
    return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
  },

  // ---- History Modal ----
  openHistoryModal() {
    this._renderHistory();
    document.getElementById('modal-history').classList.remove('hidden');
  },
  closeHistoryModal() { document.getElementById('modal-history').classList.add('hidden'); },
  _renderHistory() {
    const all = History.getAll();
    const container = document.getElementById('history-list');
    if (all.length === 0) { container.innerHTML = '<div class="empty-msg">履歴なし</div>'; return; }
    container.innerHTML = all.slice(0, 300).map(ev => {
      const t = new Date(ev.ts).toLocaleString('ja-JP', { hour12: false });
      const target = `${ev.date || ''} ${ev.shift === 'day' ? '昼' : ev.shift === 'night' ? '夜' : ''}`.trim();
      let body = '';
      if (ev.action === 'field_change' || ev.action === 'work_check') {
        body = `<span class="hist-field">${this.esc(ev.field)}</span>: <span class="hist-before">${this.esc(ev.before || '∅')}</span> → <span class="hist-after">${this.esc(ev.after || '∅')}</span>`;
      } else if (ev.action === 'entry_added' || ev.action === 'entry_added_from_work_item') {
        body = `<span class="hist-tag">追加</span> [${ev.reactor || ''}] ${this.esc(ev.entry?.title || '')}`;
      } else if (ev.action === 'entry_updated') {
        body = `<span class="hist-tag">更新</span> [${ev.reactor || ''}] ${this.esc(ev.entry?.title || '')}`;
      } else if (ev.action === 'entry_deleted' || ev.action === 'entry_removed_from_work_item') {
        body = `<span class="hist-tag hist-del">削除</span> [${ev.reactor || ''}] ${this.esc(ev.entry?.title || '')}`;
      } else if (ev.action === 'sheet_created') {
        body = `<span class="hist-tag">新規シート作成</span>`;
      } else {
        body = this.esc(ev.action || '');
      }
      return `<div class="history-item"><div class="history-meta"><span class="history-time">${t}</span><span class="history-who">${this.esc(ev.userName || '?')}</span><span class="history-target">${target}</span></div><div class="history-body">${body}</div></div>`;
    }).join('');
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

  // ---- Account ----
  _updateAccountInfo() {
    const el = document.getElementById('account-info');
    if (!el) return;
    if (Auth.isSignedIn()) {
      const name = Auth.getMemberName();
      const phone = Auth.getPhone();
      const role = Auth.isAdmin() ? '管理者' : '作業者';
      el.textContent = `${name}（${role}）${phone}`;
    } else {
      el.textContent = '未ログイン';
    }
  },

  async signOut() {
    if (!confirm('ログアウトしますか？')) return;
    await Auth.signOut();
    // onAuthChange が呼ばれてログイン画面に戻る
    location.reload();
  },

  async uploadToFirebase() {
    if (!FireSync.isEnabled()) {
      this.showToast('未接続です');
      return;
    }
    try {
      const count = await FireSync.uploadAll();
      this.showToast(`${count}件のデータを送信しました`);
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
  // ---- Time Slot helpers ----
  // 旧形式(start/end)と新形式(times[])の両方に対応
  _getEntryTimes(entry) {
    if (entry.times && entry.times.length > 0) return entry.times;
    // 旧形式からの変換
    return [{ start: entry.start || '', end: entry.end || '' }];
  },

  _renderTimeSlots(times) {
    const container = document.getElementById('entry-time-slots');
    container.innerHTML = '';
    times.forEach((t, i) => this._appendTimeSlotRow(container, t.start, t.end, i > 0));
  },

  _addTimeSlot() {
    const container = document.getElementById('entry-time-slots');
    this._appendTimeSlotRow(container, '', '', true);
  },

  _appendTimeSlotRow(container, startVal, endVal, removable) {
    const row = document.createElement('div');
    row.className = 'time-row';
    row.innerHTML = `
      <input type="time" class="form-input slot-start" value="${startVal}">
      <span>～</span>
      <input type="time" class="form-input slot-end" value="${endVal}">
      ${removable ? '<button type="button" class="btn-remove-slot">✕</button>' : '<span style="width:28px"></span>'}
    `;
    if (removable) {
      row.querySelector('.btn-remove-slot').addEventListener('click', () => row.remove());
    }
    container.appendChild(row);
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
