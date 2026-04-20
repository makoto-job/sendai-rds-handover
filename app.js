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
      if (date === this.currentDate && shift === this.currentShift) {
        this._currentData = remoteData;
        this.loadSheet();
        this.showToast('他の端末から更新されました');
      }
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
        // 時間スロットを復元
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

  // ---- Print A4 (引継帳フォーマット — 2020実績表と同一レイアウト) ----
  // リアクター容器SVG
  _reactorSVG() {
    return `<svg viewBox="0 0 90 260" width="90" height="260" xmlns="http://www.w3.org/2000/svg">
      <style>line,rect,circle,ellipse,path{stroke:#000;stroke-width:0.8;fill:none}</style>
      <!-- 脚 -->
      <path d="M20,250 L35,220 L55,220 L70,250"/>
      <line x1="20" y1="250" x2="70" y2="250"/>
      <path d="M30,235 L60,235"/>
      <!-- 本体 -->
      <rect x="25" y="50" width="40" height="170" rx="2"/>
      <!-- ドーム -->
      <path d="M25,50 Q25,20 45,15 Q65,20 65,50"/>
      <!-- ノズルTOP -->
      <rect x="40" y="8" width="10" height="10"/>
      <!-- 内部BED点線 -->
      <line x1="28" y1="90" x2="62" y2="90" stroke-dasharray="3,2"/>
      <text x="45" y="75" text-anchor="middle" font-size="6" fill="#333" stroke="none">1st</text>
      <line x1="28" y1="135" x2="62" y2="135" stroke-dasharray="3,2"/>
      <text x="45" y="120" text-anchor="middle" font-size="6" fill="#333" stroke="none">2nd</text>
      <line x1="28" y1="180" x2="62" y2="180" stroke-dasharray="3,2"/>
      <text x="45" y="165" text-anchor="middle" font-size="6" fill="#333" stroke="none">3rd</text>
      <!-- BTM -->
      <path d="M25,220 Q25,230 45,235 Q65,230 65,220"/>
      <!-- 配管 -->
      <line x1="65" y1="80" x2="80" y2="80"/>
      <line x1="65" y1="125" x2="80" y2="125"/>
      <line x1="65" y1="170" x2="80" y2="170"/>
    </svg>`;
  },

  printA4() {
    this.collectSheet();
    const projName = Store.getSetting('projectName', '2026年仙台RDSリアクター触媒交換工事');

    // 昼勤・夜勤の両方のデータを取得
    const dayData = Store.getSheet(this.currentDate, 'day') || this.createEmptySheet();
    const nightData = Store.getSheet(this.currentDate, 'night') || this.createEmptySheet();

    // 日付フォーマット
    const dateObj = new Date(this.currentDate + 'T00:00:00');
    const weekDays = ['日','月','火','水','木','金','土'];
    const dateStr = `${dateObj.getMonth()+1}月　${dateObj.getDate()}日（${weekDays[dateObj.getDay()]}）`;

    // 作業実績行を生成
    const buildEntryLines = (shiftData, rxName) => {
      const rx = shiftData?.reactors?.[rxName] || { entries: [], notes: '' };
      const entries = rx.entries || [];
      let html = '';
      entries.forEach(e => {
        const times = (e.times && e.times.length > 0) ? e.times : [{ start: e.start || '', end: e.end || '' }];
        times.forEach((t, ti) => {
          const label = ti === 0 ? (e.title || '') : '';
          const timeStr = (t.start || '') + (t.start || t.end ? '～' : '') + (t.end || '');
          const meta = [];
          if (ti === 0 && e.catalyst) meta.push(e.catalyst);
          if (ti === 0 && e.fcCount) meta.push(`${e.fcCount}/${e.fcTotal||'?'}FC`);
          if (ti === 0 && e.level) meta.push(`Ⓛ${e.level}mm`);
          html += `<div class="entry-line">`;
          if (label) html += `<span class="el-check">□</span>`;
          else html += `<span class="el-check"></span>`;
          html += `<span class="el-text">${label}${timeStr ? ' '+timeStr : ''}${meta.length ? ' '+meta.join(' ') : ''}</span>`;
          html += `</div>`;
        });
        if (e.note) {
          html += `<div class="entry-line"><span class="el-check"></span><span class="el-text el-note">${this.esc(e.note)}</span></div>`;
        }
      });
      // 引継ぎ事項
      if (rx.notes) {
        html += `<div class="entry-line" style="margin-top:4pt;border-top:1px solid #999;padding-top:2pt"><span class="el-check"></span><span class="el-text" style="font-weight:bold">【引継ぎ】${this.esc(rx.notes)}</span></div>`;
      }
      // 空行で最低行数を埋める（罫線として）
      const minLines = 18;
      const currentLines = entries.length + (rx.notes ? 2 : 0);
      for (let i = currentLines; i < minLines; i++) {
        html += `<div class="entry-line empty"></div>`;
      }
      return html;
    };

    // レベル円を生成
    const buildLevelCircle = (shiftData, rxName) => {
      const rx = shiftData?.reactors?.[rxName] || { entries: [] };
      const entries = rx.entries || [];
      // レベル値がある最後のエントリーを探す
      let levelVal = '';
      entries.forEach(e => { if (e.level) levelVal = e.level; });
      return `<div class="level-circle">
        <svg viewBox="0 0 80 80" width="70" height="70">
          <circle cx="40" cy="40" r="38" stroke="#000" stroke-width="1" fill="none"/>
          ${levelVal ? `<text x="40" y="44" text-anchor="middle" font-size="10" fill="#000" font-weight="bold">${levelVal}mm</text>` : ''}
        </svg>
      </div>`;
    };

    const printHtml = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<title>${projName} ${this.currentDate}</title>
<style>
  @page { size: A4 landscape; margin: 5mm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "MS Gothic","ＭＳ ゴシック","Noto Sans JP",monospace; font-size: 7.5pt; line-height: 1.3; }

  .page { width: 100%; height: 100%; }
  .header { text-align: center; margin-bottom: 2pt; }
  .header h1 { font-size: 9pt; margin: 0; }
  .header h2 { font-size: 11pt; margin: 0; font-weight: bold; }
  .header .date-line { font-size: 9pt; margin: 2pt 0; }

  .shift-bar { display: flex; border: 1.5pt solid #000; }
  .shift-col { flex: 1; }
  .shift-label { text-align: center; font-weight: bold; font-size: 9pt; padding: 2pt 0;
    border-bottom: 1pt solid #000; }
  .shift-label-day { background: #d0d0d0; }
  .shift-label-night { background: #333; color: #fff; }
  .shift-meta { display: flex; justify-content: space-between; padding: 1pt 4pt;
    font-size: 7.5pt; border-bottom: 1pt solid #000; }
  .shift-col + .shift-col { border-left: 1.5pt solid #000; }

  .rx-row { display: flex; border-left: 1.5pt solid #000; border-right: 1.5pt solid #000;
    border-bottom: 1.5pt solid #000; min-height: 42%; }
  .rx-half { flex: 1; display: flex; padding: 2pt; }
  .rx-half + .rx-half { border-left: 1.5pt solid #000; }

  .rx-name { font-weight: bold; font-size: 9pt; writing-mode: vertical-rl;
    text-orientation: mixed; padding: 2pt 1pt; border-right: 0.5pt solid #999;
    display: flex; align-items: center; }
  .rx-body { flex: 1; display: flex; }
  .rx-illust { width: 95pt; display: flex; align-items: center; justify-content: center;
    border-right: 0.5pt dotted #aaa; }
  .rx-illust svg { width: 80pt; height: auto; }
  .rx-records { flex: 1; display: flex; flex-direction: column; padding: 1pt 3pt; }
  .rx-records-header { font-weight: bold; font-size: 8pt; text-align: center;
    border-bottom: 0.5pt solid #000; margin-bottom: 2pt; padding-bottom: 1pt; }

  .entry-line { display: flex; min-height: 11pt; border-bottom: 0.5pt dotted #ccc;
    align-items: baseline; padding: 0.5pt 0; }
  .entry-line.empty { }
  .el-check { width: 10pt; font-size: 7pt; text-align: center; flex-shrink: 0; }
  .el-text { flex: 1; font-size: 7pt; white-space: pre-wrap; word-break: break-all; }
  .el-note { color: #555; font-size: 6.5pt; }

  .level-circle { position: absolute; top: 2pt; right: 2pt; }
  .rx-records { position: relative; }
</style>
</head><body>
<div class="page">
  <div class="header">
    <h1>ENEOS（株）仙台製油所</h1>
    <h2>RDS－RX－01＆02A　触媒交換工事実績表</h2>
    <div class="date-line">${dateStr}</div>
  </div>

  <div class="shift-bar">
    <div class="shift-col">
      <div class="shift-label shift-label-day">昼　勤</div>
      <div class="shift-meta">
        <span>天候（${dayData.weather || '　　'}）</span>
        <span>気温（　　）</span>
        <span>担当：${dayData.supervisor || ''}</span>
      </div>
    </div>
    <div class="shift-col">
      <div class="shift-label shift-label-night">夜　勤</div>
      <div class="shift-meta">
        <span>天候（${nightData.weather || '　　'}）</span>
        <span>気温（　　）</span>
        <span>担当：${nightData.supervisor || ''}</span>
      </div>
    </div>
  </div>

  <!-- RX-01A row -->
  <div class="rx-row">
    <div class="rx-half">
      <div class="rx-name">RX-01A</div>
      <div class="rx-body">
        <div class="rx-illust">${this._reactorSVG()}</div>
        <div class="rx-records">
          <div class="rx-records-header">【作業実績】</div>
          ${buildLevelCircle(dayData, 'RX-01A')}
          ${buildEntryLines(dayData, 'RX-01A')}
        </div>
      </div>
    </div>
    <div class="rx-half">
      <div class="rx-name">RX-01A</div>
      <div class="rx-body">
        <div class="rx-illust">${this._reactorSVG()}</div>
        <div class="rx-records">
          <div class="rx-records-header">【作業実績】</div>
          ${buildLevelCircle(nightData, 'RX-01A')}
          ${buildEntryLines(nightData, 'RX-01A')}
        </div>
      </div>
    </div>
  </div>

  <!-- RX-02A row -->
  <div class="rx-row">
    <div class="rx-half">
      <div class="rx-name">RX-02A</div>
      <div class="rx-body">
        <div class="rx-illust">${this._reactorSVG()}</div>
        <div class="rx-records">
          <div class="rx-records-header">【作業実績】</div>
          ${buildLevelCircle(dayData, 'RX-02A')}
          ${buildEntryLines(dayData, 'RX-02A')}
        </div>
      </div>
    </div>
    <div class="rx-half">
      <div class="rx-name">RX-02A</div>
      <div class="rx-body">
        <div class="rx-illust">${this._reactorSVG()}</div>
        <div class="rx-records">
          <div class="rx-records-header">【作業実績】</div>
          ${buildLevelCircle(nightData, 'RX-02A')}
          ${buildEntryLines(nightData, 'RX-02A')}
        </div>
      </div>
    </div>
  </div>
</div>
</body></html>`;

    const w = window.open('', '_blank');
    w.document.write(printHtml);
    w.document.close();
    setTimeout(() => w.print(), 400);
  },

  // ---- Export All PDF (日付単位で printA4 と同一フォーマット) ----
  exportAllPDF() {
    const allKeys = Store.getDates();
    if (allKeys.length === 0) { this.showToast('データがありません'); return; }

    // 日付の一覧を重複排除で取得
    const uniqueDates = [...new Set(allKeys.map(k => k.substring(0, 10)))].sort();

    // 各日付ごとのページを生成するため、一時的に currentDate を切り替え
    const savedDate = this.currentDate;
    const savedShift = this.currentShift;

    // printA4 と同じレイアウトを流用して全ページ生成
    let pagesHtml = '';
    uniqueDates.forEach((date, i) => {
      this.currentDate = date;
      // 各日付で昼夜両方のデータを取得
      const dayData = Store.getSheet(date, 'day') || this.createEmptySheet();
      const nightData = Store.getSheet(date, 'night') || this.createEmptySheet();
      const dateObj = new Date(date + 'T00:00:00');
      const weekDays = ['日','月','火','水','木','金','土'];
      const dateStr = `${dateObj.getMonth()+1}月　${dateObj.getDate()}日（${weekDays[dateObj.getDay()]}）`;

      const buildLines = (sd, rx) => {
        const r = sd?.reactors?.[rx] || { entries: [], notes: '' };
        let h = '';
        (r.entries||[]).forEach(e => {
          const times = (e.times && e.times.length > 0) ? e.times : [{ start: e.start||'', end: e.end||'' }];
          times.forEach((t,ti) => {
            const lb = ti===0 ? (e.title||'') : '';
            const ts = (t.start||'') + (t.start||t.end ? '～' : '') + (t.end||'');
            const m = [];
            if (ti===0 && e.catalyst) m.push(e.catalyst);
            if (ti===0 && e.fcCount) m.push(`${e.fcCount}/${e.fcTotal||'?'}FC`);
            if (ti===0 && e.level) m.push(`Ⓛ${e.level}mm`);
            h += `<div class="entry-line"><span class="el-check">${lb?'□':''}</span><span class="el-text">${lb}${ts?' '+ts:''}${m.length?' '+m.join(' '):''}</span></div>`;
          });
        });
        if (r.notes) h += `<div class="entry-line" style="margin-top:4pt;border-top:1px solid #999;padding-top:2pt"><span class="el-check"></span><span class="el-text" style="font-weight:bold">【引継ぎ】${this.esc(r.notes)}</span></div>`;
        const min = 18, cur = (r.entries||[]).length + (r.notes?2:0);
        for (let j = cur; j < min; j++) h += '<div class="entry-line empty"></div>';
        return h;
      };

      const pageBreak = i < uniqueDates.length - 1 ? 'page-break-after:always;' : '';
      pagesHtml += `<div class="page" style="${pageBreak}">
        <div class="header"><h1>ENEOS（株）仙台製油所</h1><h2>RDS－RX－01＆02A　触媒交換工事実績表</h2><div class="date-line">${dateStr}</div></div>
        <div class="shift-bar"><div class="shift-col"><div class="shift-label shift-label-day">昼　勤</div><div class="shift-meta"><span>天候（${dayData.weather||'　'}）</span><span>担当：${dayData.supervisor||''}</span></div></div><div class="shift-col"><div class="shift-label shift-label-night">夜　勤</div><div class="shift-meta"><span>天候（${nightData.weather||'　'}）</span><span>担当：${nightData.supervisor||''}</span></div></div></div>
        <div class="rx-row"><div class="rx-half"><div class="rx-name">RX-01A</div><div class="rx-body"><div class="rx-illust">${this._reactorSVG()}</div><div class="rx-records"><div class="rx-records-header">【作業実績】</div>${buildLines(dayData,'RX-01A')}</div></div></div><div class="rx-half"><div class="rx-name">RX-01A</div><div class="rx-body"><div class="rx-illust">${this._reactorSVG()}</div><div class="rx-records"><div class="rx-records-header">【作業実績】</div>${buildLines(nightData,'RX-01A')}</div></div></div></div>
        <div class="rx-row"><div class="rx-half"><div class="rx-name">RX-02A</div><div class="rx-body"><div class="rx-illust">${this._reactorSVG()}</div><div class="rx-records"><div class="rx-records-header">【作業実績】</div>${buildLines(dayData,'RX-02A')}</div></div></div><div class="rx-half"><div class="rx-name">RX-02A</div><div class="rx-body"><div class="rx-illust">${this._reactorSVG()}</div><div class="rx-records"><div class="rx-records-header">【作業実績】</div>${buildLines(nightData,'RX-02A')}</div></div></div></div>
      </div>`;
    });

    // 復元
    this.currentDate = savedDate;
    this.currentShift = savedShift;

    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>全日分実績表</title>
    <style>
      @page { size: A4 landscape; margin: 5mm; }
      * { margin:0;padding:0;box-sizing:border-box; }
      body { font-family:"MS Gothic","ＭＳ ゴシック","Noto Sans JP",monospace; font-size:7.5pt; line-height:1.3; }
      .page { width:100%; }
      .header { text-align:center;margin-bottom:2pt; } .header h1 { font-size:9pt;margin:0; } .header h2 { font-size:11pt;margin:0;font-weight:bold; } .header .date-line { font-size:9pt;margin:2pt 0; }
      .shift-bar { display:flex;border:1.5pt solid #000; } .shift-col { flex:1; } .shift-label { text-align:center;font-weight:bold;font-size:9pt;padding:2pt 0;border-bottom:1pt solid #000; } .shift-label-day { background:#d0d0d0; } .shift-label-night { background:#333;color:#fff; } .shift-meta { display:flex;justify-content:space-between;padding:1pt 4pt;font-size:7.5pt;border-bottom:1pt solid #000; } .shift-col + .shift-col { border-left:1.5pt solid #000; }
      .rx-row { display:flex;border-left:1.5pt solid #000;border-right:1.5pt solid #000;border-bottom:1.5pt solid #000;min-height:42%; } .rx-half { flex:1;display:flex;padding:2pt; } .rx-half + .rx-half { border-left:1.5pt solid #000; }
      .rx-name { font-weight:bold;font-size:9pt;writing-mode:vertical-rl;text-orientation:mixed;padding:2pt 1pt;border-right:0.5pt solid #999;display:flex;align-items:center; }
      .rx-body { flex:1;display:flex; } .rx-illust { width:95pt;display:flex;align-items:center;justify-content:center;border-right:0.5pt dotted #aaa; } .rx-illust svg { width:80pt;height:auto; }
      .rx-records { flex:1;display:flex;flex-direction:column;padding:1pt 3pt; } .rx-records-header { font-weight:bold;font-size:8pt;text-align:center;border-bottom:0.5pt solid #000;margin-bottom:2pt;padding-bottom:1pt; }
      .entry-line { display:flex;min-height:11pt;border-bottom:0.5pt dotted #ccc;align-items:baseline;padding:0.5pt 0; } .el-check { width:10pt;font-size:7pt;text-align:center;flex-shrink:0; } .el-text { flex:1;font-size:7pt;white-space:pre-wrap;word-break:break-all; }
    </style></head><body>${pagesHtml}</body></html>`);
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
