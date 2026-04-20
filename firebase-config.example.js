/* ========================================
   Firebase 設定テンプレート
   実際の値は firebase-config.local.js に記述（git管理外）
   ======================================== */
'use strict';

const FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY_HERE",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

// プロジェクトID（Firestoreコレクションパス用）
const HIKI_PROJECT_ID = "sendai_rds_2026";

// プロジェクトパスコード（管理者が決めてLINE等で共有する）
const PROJECT_PASSCODE = "YOUR_PASSCODE_HERE";
