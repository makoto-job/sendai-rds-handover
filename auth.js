/* ========================================
   仙台RDS 引継帳 — 認証モジュール
   匿名認証＋パスコード方式
   ======================================== */
'use strict';

const Auth = {
  _user: null,
  _member: null,
  _onAuthChange: null,

  async init(onAuthChange) {
    this._onAuthChange = onAuthChange;

    if (!firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
    }

    firebase.auth().onAuthStateChanged(async user => {
      this._user = user;
      if (user) {
        this._member = await this._fetchMember(user.uid);
      } else {
        this._member = null;
      }
      if (this._onAuthChange) this._onAuthChange(user, this._member);
    });
  },

  async _fetchMember(uid) {
    try {
      const doc = await firebase.firestore()
        .collection('projects').doc(HIKI_PROJECT_ID)
        .collection('members').doc(uid)
        .get();
      return doc.exists ? doc.data() : null;
    } catch (e) {
      console.warn('[Auth] メンバー確認エラー:', e.message);
      return null;
    }
  },

  // パスコード検証
  checkPasscode(input) {
    return input === PROJECT_PASSCODE;
  },

  // 匿名ログイン
  async signInAnonymously() {
    const result = await firebase.auth().signInAnonymously();
    return result.user;
  },

  // メンバー登録
  async registerMember(name, role) {
    const uid = this.getUid();
    if (!uid) throw new Error('未ログイン');

    const data = {
      name: name,
      role: role || 'worker',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    await firebase.firestore()
      .collection('projects').doc(HIKI_PROJECT_ID)
      .collection('members').doc(uid)
      .set(data);

    this._member = data;
    return data;
  },

  async signOut() {
    await firebase.auth().signOut();
    this._member = null;
  },

  getUser() { return this._user; },
  getUid() { return this._user?.uid || null; },
  getPhone() { return null; },
  getMember() { return this._member; },
  getMemberName() { return this._member?.name || '不明'; },
  getMemberRole() { return this._member?.role || null; },
  isAdmin() { return this._member?.role === 'admin'; },
  isMember() { return this._member !== null; },
  isSignedIn() { return this._user !== null; }
};
