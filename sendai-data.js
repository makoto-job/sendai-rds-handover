/* ========================================
   仙台RDS 引継帳 — データ定義
   ======================================== */
'use strict';

// 仙台RDS触媒工事 作業項目マスタ
const SENDAI_WORK_ITEMS = {
  // 抜出段取り
  nukidashi_dandori: [
    'TOP/E取外し',
    'BTM/E仕切り挿入',
    '6Fクエンチ仕切り挿入',
    '9Fクエンチ仕切り挿入',
    'TOP/E本体側目視検査',
    'TOP雨風養生',
    'バキューム設備設置',
    '抜出段取り',
    'エアー置換',
    '入槽前客先立会ガス検'
  ],
  // 抜出作業
  nukidashi_sagyo: [
    'ﾄｯﾌﾟ M/W 開放',
    '1st BED 触媒抜出',
    'No.1 M/W 開放',
    '2nd BED 触媒抜出',
    'No.2 M/W 開放',
    '3rd BED 触媒抜出',
    '廃触媒ｻﾝﾌﾟﾘﾝｸﾞ',
    'MW⇒触媒ﾚﾍﾞﾙ',
    'クエンチエアー導入9FC',
    'クエンチエアー導入6FC',
    'TOP雨風養生撤去',
    '掘削機上荷・設置',
    'TOP雨風養生',
    '壁崩し',
    '拡幅時⇒全閉完了',
    '拡幅開始⇒拡幅完了',
    '掘削機抜出【1stBED】',
    '掘削機抜出【2ndBED】',
    '掘削機 パイプ接続1～3本目',
    '掘削機 パイプ接続4本目',
    '掘削機 パイプ接続5本目',
    '掘削機 パイプ接続1～8本目',
    '掘削機 パイプ接続9本目',
    '掘削機 パイプ接続10本目',
    '掘削機解体'
  ],
  // 内部清掃
  naibu_seiso: [
    '抜出し機材片付',
    'BTM仮蓋開放（スペーサー挿入）',
    'ｴｱｰ置換',
    'ﾏｽｸ無客先殿立会ｶﾞｽ検',
    '掘削機荷下ろし',
    '内部清掃',
    '粗清掃',
    'W.JET段取り',
    'W.JET洗浄',
    '清掃後客先殿検査',
    'ｸｴﾝﾁ通風ﾃｽﾄ',
    'ﾒｯｼｭ補修',
    'TOPトレイ水平度測定',
    'Topﾄﾚｲ',
    'Topﾊﾟｰﾌｫﾚｲﾃｯﾄﾞﾄﾚｲ',
    'Topﾁﾑﾆｰﾄﾚｲ',
    'No.1 ﾄﾚｲ',
    'No.1 ｸﾞﾘｯﾄﾞ',
    'No.1 ﾊﾟｰﾌｫﾚｲﾃｯﾄﾞﾄﾚｲ',
    'No.1 ﾁﾑﾆｰﾄﾚｲ',
    'No.2 ﾄﾚｲ',
    'No.2 ｸﾞﾘｯﾄﾞ',
    'No.2 ﾊﾟｰﾌｫﾚｲﾃｯﾄﾞﾄﾚｲ',
    'No.2 ﾁﾑﾆｰﾄﾚｲ',
    'BTM'
  ],
  // 充填段取り
  juten_dandori: [
    '充填段取',
    'ﾘｱｸﾀｰ内部養生',
    'ﾒｯｼｭ補修',
    'ヤーン詰め',
    '在庫触媒、C/B横持ち',
    'ＪＥﾛｰﾀﾞｰ上荷',
    'セパレーター解体',
    'セパレーター清掃',
    '内部シート養生'
  ],
  // 触媒充填
  shokubai_juten: [
    '3rd BED 充填前確認',
    '3rd BED ｾﾗﾐｯｸﾎﾞｰﾙ充填(1/8)',
    '3rd BED JE充填',
    '3rd BED Sock充填',
    'No.2ﾁﾑﾆｰ貫通確認',
    'No.2 M/W復旧',
    '2nd BED 充填前確認',
    '2nd BED ｾﾗﾐｯｸﾎﾞｰﾙ充填(1/8)',
    '2nd BED JE充填',
    '2nd BED Sock充填',
    'No.1ﾁﾑﾆｰ貫通確認',
    'No.1 M/W復旧',
    '1st BED ｾﾗﾐｯｸﾎﾞｰﾙ充填(1/8)',
    '1st BED Sock充填',
    'ﾄｯﾌﾟﾁﾑﾆｰ貫通確認',
    'ﾄｯﾌﾟ M/W復旧',
    'ｲﾝﾚｯﾄﾊﾞｽｹｯﾄ復旧',
    'JE設備段取・設置',
    'Sock→JE切り替え',
    'JE→Sock切り替え',
    'トレイ水平度'
  ],
  // 片付け
  katazuke: [
    'TOP/E復旧',
    'BTM/E復旧',
    '6Fクエンチ復旧',
    '9Fクエンチ復旧',
    'スチームリング復旧',
    'TOP雨風養生撤去',
    '資機材荷下ろし',
    '資機材片付け',
    'リング当たり確認',
    'フレンジリップ面確認'
  ]
};

// 作業項目カテゴリのラベル
const WORK_CATEGORY_LABELS = {
  nukidashi_dandori: '抜出段取り',
  nukidashi_sagyo: '抜出作業',
  naibu_seiso: '内部清掃',
  juten_dandori: '充填段取り',
  shokubai_juten: '触媒充填',
  katazuke: '片付け'
};

// 触媒名マスタ
const CATALYST_NAMES = [
  'KG 57-50', 'KG 57-65', 'KG 57-80', 'KG 57-100',
  'KG 1-5B', 'KG 5M-3Q', 'KG 5M-2Q',
  'KFR 16-1.5Q', 'KFR 24-1.5Q', 'KFR 24-1.3Q',
  'KFR 33-1.3Q', 'KFR 50-1.3Q', 'KFR 95-1.3Q',
  'CB 1/8B'
];

// リアクター定義（仙台）
const REACTORS = ['RX-01A', 'RX-02A'];

// 担当者リストはアプリ内の設定画面で登録する（個人情報はコードに含めない）
// localStorage の 'vha_staff' キーに保存される

// 作業項目→実績入力のデフォルト値マッピング
// fields: どの入力欄を表示するか (catalyst, fc, level)
// catalyst: 自動選択する触媒名（部分一致で候補を絞る）
const WORK_ITEM_DEFAULTS = {
  // ---- 抜出作業 → FC・レベル入力あり ----
  '1st BED 触媒抜出':   { fields: ['fc','level'], catalyst: '' },
  '2nd BED 触媒抜出':   { fields: ['fc','level'], catalyst: '' },
  '3rd BED 触媒抜出':   { fields: ['fc','level'], catalyst: '' },
  '掘削機抜出【1stBED】': { fields: ['fc','level'], catalyst: '' },
  '掘削機抜出【2ndBED】': { fields: ['fc','level'], catalyst: '' },

  // ---- 触媒充填 → 触媒名・FC・レベル入力あり ----
  '3rd BED ｾﾗﾐｯｸﾎﾞｰﾙ充填(1/8)': { fields: ['catalyst','fc','level'], catalyst: 'CB 1/8B' },
  '3rd BED JE充填':              { fields: ['catalyst','fc','level'], catalyst: 'KFR 33-1.3Q' },
  '3rd BED Sock充填':            { fields: ['catalyst','fc','level'], catalyst: 'KFR 50-1.3Q' },
  '2nd BED ｾﾗﾐｯｸﾎﾞｰﾙ充填(1/8)': { fields: ['catalyst','fc','level'], catalyst: 'CB 1/8B' },
  '2nd BED JE充填':              { fields: ['catalyst','fc','level'], catalyst: 'KFR 24-1.3Q' },
  '2nd BED Sock充填':            { fields: ['catalyst','fc','level'], catalyst: 'KFR 24-1.5Q' },
  '1st BED ｾﾗﾐｯｸﾎﾞｰﾙ充填(1/8)': { fields: ['catalyst','fc','level'], catalyst: 'CB 1/8B' },
  '1st BED Sock充填':            { fields: ['catalyst','fc','level'], catalyst: 'KG 5M-3Q' },
  '3rd BED 充填前確認':           { fields: [], catalyst: '' },
  '2nd BED 充填前確認':           { fields: [], catalyst: '' },

  // ---- M/W・復旧 → 時間のみ ----
  'ﾄｯﾌﾟ M/W 開放': { fields: [], catalyst: '' },
  'No.1 M/W 開放':  { fields: [], catalyst: '' },
  'No.2 M/W 開放':  { fields: [], catalyst: '' },
  'No.2 M/W復旧':   { fields: [], catalyst: '' },
  'No.1 M/W復旧':   { fields: [], catalyst: '' },
  'ﾄｯﾌﾟ M/W復旧':   { fields: [], catalyst: '' },
  'TOP/E復旧':       { fields: [], catalyst: '' },
  'BTM/E復旧':       { fields: [], catalyst: '' },
  '6Fクエンチ復旧':   { fields: [], catalyst: '' },
  '9Fクエンチ復旧':   { fields: [], catalyst: '' },
};
