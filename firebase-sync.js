/* ========================================
   仙台RDS 引継帳 — Firebase Sync Module
   認証済みユーザーのみFirestoreと同期
   ======================================== */
'use strict';

const FireSync = {
  db: null,
  _listeners: [],
  _enabled: false,
  _onUpdate: null,

  // 初期化（Auth初期化後に呼ぶ前提）
  async init(onUpdate) {
    this._onUpdate = onUpdate;

    if (typeof firebase === 'undefined') {
      console.warn('[FireSync] Firebase SDK未読込');
      return false;
    }
    if (typeof FIREBASE_CONFIG === 'undefined') {
      console.warn('[FireSync] firebase-config.local.js が読み込まれていません');
      return false;
    }

    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(FIREBASE_CONFIG);
      }
      this.db = firebase.firestore();

      // オフライン永続化（2回目以降はエラーになるので無視）
      try {
        await this.db.enablePersistence({ synchronizeTabs: true });
      } catch (err) {
        if (err.code === 'failed-precondition') {
          console.warn('[FireSync] 複数タブ検出 — 永続化は1タブのみ');
        } else if (err.code === 'unimplemented') {
          console.warn('[FireSync] このブラウザはオフライン永続化非対応');
        }
      }

      this._enabled = true;
      console.log('[FireSync] 初期化完了');
      return true;
    } catch (e) {
      console.error('[FireSync] 初期化失敗:', e);
      return false;
    }
  },

  isEnabled() {
    return this._enabled && this.db !== null && Auth.isMember();
  },

  _projectId() { return HIKI_PROJECT_ID; },

  _docRef(date, shift) {
    return this.db.collection('projects').doc(this._projectId())
      .collection('sheets').doc(`${date}_${shift}`);
  },

  _auditRef() {
    return this.db.collection('projects').doc(this._projectId())
      .collection('audit');
  },

  // 保存時に updatedBy 情報を付与
  _withAuditFields(data) {
    return {
      ...data,
      updatedBy: Auth.getUid(),
      updatedByName: Auth.getMemberName(),
      updatedByPhone: Auth.getPhone(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
  },

  // 保存（Firestore）
  async saveSheet(date, shift, data) {
    if (!this.isEnabled()) return;
    try {
      const payload = this._withAuditFields(data);
      await this._docRef(date, shift).set(payload, { merge: true });

      // 監査ログ追記
      await this._auditRef().add({
        action: 'update',
        sheetId: `${date}_${shift}`,
        userId: Auth.getUid(),
        userName: Auth.getMemberName(),
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
      });

      console.log(`[FireSync] 同期完了: ${date}_${shift}`);
    } catch (e) {
      console.warn('[FireSync] 保存失敗:', e.message);
    }
  },

  // 読込
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

  // リアルタイムリスナー
  listenSheet(date, shift) {
    if (!this.isEnabled()) return;
    this.stopListeners();

    const unsub = this._docRef(date, shift).onSnapshot(doc => {
      if (doc.exists && doc.metadata.hasPendingWrites === false) {
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

  // 全シート一覧
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

  stopListeners() {
    this._listeners.forEach(fn => fn());
    this._listeners = [];
  },

  // 全データ一括アップロード
  async uploadAll() {
    if (!this.isEnabled()) return 0;
    const dates = Store.getDates();
    let count = 0;

    for (const k of dates) {
      const match = k.match(/^(\d{4}-\d{2}-\d{2})_(day|night)$/);
      if (!match) continue;
      const [, date, shift] = match;
      const data = Store.getSheet(date, shift);
      if (data) {
        await this.saveSheet(date, shift, data);
        count++;
      }
    }

    console.log(`[FireSync] ${count}件アップロード完了`);
    return count;
  },

  // 全データダウンロード
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
