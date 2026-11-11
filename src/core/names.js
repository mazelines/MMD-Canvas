// Name handling: standard MMD bone name translation + identifier sanitising.

const PARTS = [
  ['左', 'Left'], ['右', 'Right'],
  ['全ての親', 'Root'], ['センター先', 'CenterTip'], ['センター', 'Center'], ['グルーブ', 'Groove'],
  ['上半身', 'UpperBody'], ['下半身', 'LowerBody'], ['腰', 'Waist'],
  ['首', 'Neck'], ['頭', 'Head'], ['両目', 'Eyes'], ['目', 'Eye'], ['舌', 'Tongue'], ['顎', 'Jaw'], ['歯', 'Teeth'],
  ['肩', 'Shoulder'], ['腕', 'Arm'], ['ひじ', 'Elbow'], ['手首', 'Wrist'], ['手捩', 'HandTwist'], ['捩', 'Twist'],
  ['親指', 'Thumb'], ['人指', 'Index'], ['人差指', 'Index'], ['中指', 'Middle'], ['薬指', 'Ring'], ['小指', 'Little'],
  ['足首', 'Ankle'], ['足ＩＫ', 'LegIK'], ['足IK', 'LegIK'], ['つま先ＩＫ', 'ToeIK'], ['つま先IK', 'ToeIK'],
  ['つま先', 'Toe'], ['ひざ', 'Knee'], ['足', 'Leg'], ['手', 'Hand'], ['ダミー', 'Dummy'],
  ['操作中心', 'ViewCenter'], ['スカート', 'Skirt'], ['髪', 'Hair'], ['前', 'Front'], ['後', 'Back'], ['横', 'Side'],
  ['胸', 'Breast'], ['ネクタイ', 'Tie'], ['袖', 'Sleeve'], ['リボン', 'Ribbon'], ['尻尾', 'Tail'], ['耳', 'Ear'],
  ['先', 'Tip'], ['親', 'Parent'], ['ＩＫ', 'IK'], ['上', 'Upper'], ['下', 'Lower'], ['中', 'Mid'],
  ['０', '0'], ['１', '1'], ['２', '2'], ['３', '3'], ['４', '4'], ['５', '5'], ['６', '6'], ['７', '7'], ['８', '8'], ['９', '9'],
  ['Ｄ', 'D'], ['Ｃ', 'C'], ['＿', '_'], ['＋', 'Plus'], ['－', '_'], ['・', '_'], ['　', '_'],
];

// longest pattern first, so 手首 (Wrist) wins over 手 (Hand) + 首 (Neck)
PARTS.sort((a, b) => b[0].length - a[0].length);

const ASCII_ONLY = /^[\x20-\x7e]+$/;

/** Best-effort JP -> EN for bone names. Returns null when non-ASCII remains. */
export function translateName(jp) {
  let s = jp;
  for (const [a, b] of PARTS) s = s.split(a).join(b);
  s = s.trim();
  return s && ASCII_ONLY.test(s) ? s : null;
}

/**
 * @param {{name:string,nameEn:string}} item
 * @param {'original'|'english'} mode
 */
export function pickName(item, mode, translate = false) {
  if (mode === 'english') {
    const en = (item.nameEn || '').trim();
    if (en && ASCII_ONLY.test(en)) return en;
    if (translate) {
      const t = translateName(item.name || '');
      if (t) return t;
    }
  }
  return (item.name || '').trim() || (item.nameEn || '').trim();
}

/** Make names unique by appending _2, _3 ... */
export function uniquify(names, fallbackPrefix = 'item') {
  const used = new Map();
  return names.map((raw, i) => {
    let n = raw || `${fallbackPrefix}_${i}`;
    const key = n.toLowerCase();
    if (!used.has(key)) { used.set(key, 1); return n; }
    let k = used.get(key);
    let cand;
    do { k++; cand = `${n}_${k}`; } while (used.has(cand.toLowerCase()));
    used.set(key, k);
    used.set(cand.toLowerCase(), 1);
    return cand;
  });
}

/** USD prim identifier. USD >= 24.03 accepts UTF-8 (XID) identifiers; asciiOnly forces [A-Za-z0-9_]. */
export function usdIdentifier(name, asciiOnly = false) {
  let out = '';
  for (const ch of name.normalize('NFKC')) {
    if (/[A-Za-z0-9_]/.test(ch)) out += ch;
    else if (!asciiOnly && /[\p{L}\p{Nd}]/u.test(ch)) out += ch;
    else if (asciiOnly && ch.codePointAt(0) > 0x7f) out += 'u' + ch.codePointAt(0).toString(16);
    else out += '_';
  }
  if (!out) out = '_';
  if (/^[0-9]/.test(out)) out = '_' + out;
  return out;
}
