/* ========================================
   仙台RDS 引継帳 — Firebase Sync Module
   Firestore リアルタイム同期 + オフライン対応
   ======================================== */
'use strict';

const FireSync = {
  db: null,
  _listeners: [],
  _enabled: false,
  _onUpdate: null, // callback when remote data changes

  // Firebase設定（設定画面から入力、localStorageに保存）
  getConfig() {
    try { return JSON.parse(localStorage.getItem('firebase_config')) || null; }
    catch { return null; }
  },
  saveConfig(config) {
    localStorage.setItem('firebase_config', JSON.stringify(config));
  },

  // 初期化
  async init(onUpdate) {
    this._onUpdate = onUpdate;
    const config = this.getConfig();
    if (!config || !config.apiKey) {
      console.log('[FireSync] Firebase未設定 — ローカルのみモード');
      return false;
    }

    try {
      // Firebase SDK は CDN から読み込み済みを前提
      if (typeof firebase === 'undefined') {
        console.warn('[FireSync] Firebase SDK未読込');
        return false;
      }

      // 初期化（重複防止）
      if (!firebase.apps.length) {
        firebase.initializeApp(config);
      }

      this.db = firebase.firestore();
      // オフライン永続化を有効化
      await this.db.enablePersistence({ synchronizeTabs: true }).catch(err => {
        if (err.code === 'failed-precondition') {
          console.warn('[FireSync] 複数タブ使用中 — 永続化は1タブのみ');
        } else if (err.code === 'unimplemented') {
          console.warn('[FireSync] このブラウザはオフライン永続化非対応');
        }
      });

      this._enabled = true;
      console.log('[FireSync] 初期化完了');
      return true;
    } catch (e) {
      console.error('[FireSync] 初期化失敗:', e);
      return false;
    }
  },

  isEnabled() { return this._enabled && this.db !== null; },

  // コレクションパス: projects/{projectId}/sheets/{date}_{shift}
  _projectId() {
    return localStorage.getItem('firebase_project_id') || 'sendai_rds_2026';
  },

  _docRef(date, shift) {
    return this.db.collection('projects').doc(this._projectId())
      .collection('sheets').doc(`${date}_${shift}`);
  },

  // 保存（ローカル→Firebase）
  async saveSheet(date, shift, data) {
    if (!this.isEnabled()) return;
    try {
      await this._docRef(date, shift).set(data, { merge: true });
      console.log(`[FireSync] 同期完了: ${date}_${shift}`);
    } catch (e) {
      console.warn('[FireSync] 保存失敗（オフライン中はキューに入る）:', e.message);
    }
  },

  // 読込（Firebase→ローカル）
  async loadSheet(date, shift) {
    if (!this.isEnabled()) return null;
    try {
      const doc = await this._docRef(date, shift).get();
      return doc.exists ? doc.data() : null;
    } catch (e) {
      console.warn('[FireSync] 読込失敗:', e.message);
      return null;
    }
  },

  // リアルタイムリスナー開始（特定の日のシートを監視）
  listenSheet(date, shift) {
    if (!this.isEnabled()) return;

    // 既存リスナーを停止
    this.stopListeners();

    const unsub = this._docRef(date, shift).onSnapshot(doc => {
      if (doc.exists && doc.metadata.hasPendingWrites === false) {
        // リモートからの変更（自分の書込み以外）
        console.log(`[FireSync] リモート更新受信: ${date}_${shift}`);
        if (this._onUpdate) {
          this._onUpdate(date, shift, doc.data());
        }
      }
    }, err => {
      console.warn('[FireSync] リスナーエラー:', err.message);
    });

    this._listeners.push(unsub);
  },

  // 全シート一覧取得
  async listSheets() {
    if (!this.isEnabled()) return [];
    try {
      const snap = await this.db.collection('projects').doc(this._projectId())
        .collection('sheets').orderBy('date', 'desc').get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
      console.warn('[FireSync] 一覧取得失敗:', e.message);
      return [];
    }
  },

  // リスナー停止
  stopListeners() {
    this._listeners.forEach(fn => fn());
    this._listeners = [];
  },

  // 全データ同期（ローカル→Firebase一括アップロード）
  async uploadAll() {
    if (!this.isEnabled()) return 0;
    const dates = Store.getDates();
    let count = 0;
    const batch = this.db.batch();

    for (const k of dates) {
      const match = k.match(/^(\d{4}-\d{2}-\d{2})_(day|night)$/);
      if (!match) continue;
      const [, date, shift] = match;
      const data = Store.getSheet(date, shift);
      if (data) {
        batch.set(this._docRef(date, shift), data, { merge: true });
        count++;
      }
    }

    if (count > 0) {
      await batch.commit();
      console.log(`[FireSync] ${count}件アップロード完了`);
    }
    return count;
  },

  // 全データ同期（Firebase→ローカル一括ダウンロード）
  async downloadAll() {
    if (!this.isEnabled()) return 0;
    const sheets = await this.listSheets();
    let count = 0;
    sheets.forEach(sheet => {
      const match = sheet.id.match(/^(\d{4}-\d{2}-\d{2})_(day|night)$/);
      if (!match) return;
      const [, date, shift] = match;
      Store.saveSheet(date, shift, sheet);
      count++;
    });
    return count;
  }
};
