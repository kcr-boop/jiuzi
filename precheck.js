/*
 * 鸠兹听澜 · 市民端「诉求预检」（说得清）浏览器版
 * 逐行移植自 02_演示应用/pipeline/precheck.py 与 pipeline/c1_preprocess.py（脱敏 + 属地）。
 * 规则数据与正则由 build_site.py 从 Python 原样导出到 data/precheck.json，本文件只实现逻辑；
 * 用 test_parity 与 Python 版逐项比对，保证同一段文字给出同样的结论。
 * 不用正则后行断言（老款 iPhone 不支持）。
 */
(function (root) {
  let D = null;
  const RX = {};

  function init(d) {
    D = d;
    for (const k of Object.keys(d.patterns)) RX[k] = new RegExp(d.patterns[k]);
    D.civil = d.civil.map(([p, why]) => [new RegExp(p), why]);
    return true;
  }

  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function finditer(re, t) {
    const g = new RegExp(re.source, "g");
    const out = [];
    let m;
    while ((m = g.exec(t)) !== null) {
      out.push({ start: m.index, end: m.index + m[0].length, m });
      if (m[0].length === 0) g.lastIndex++;
    }
    return out;
  }

  /* ---------- c1_preprocess.mask ---------- */
  function mask(text) {
    const stats = {};
    let s = text || "";
    const sub = (re, fn, key) => {
      let n = 0;
      s = s.replace(re, (...a) => { n++; return fn(...a); });
      if (n) stats[key] = (stats[key] || 0) + n;
    };
    // Python: (?<!\d)(\d{6})\d{8}(\d{3}[\dXx])(?!\d)  → 用 (^|\D) 代替后行断言
    sub(/(^|\D)(\d{6})\d{8}(\d{3}[\dXx])(?!\d)/g, (m, p, a, b) => p + a + "********" + b, "身份证号");
    sub(/(^|\D)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g, (m, p, a, b) => p + a + "****" + b, "手机号");
    sub(/([京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-Z])[A-Z0-9]{3,4}([A-Z0-9]{2})(?![A-Z0-9])/g,
        (m, a, b) => a + "***" + b, "车牌号");
    return [s, stats];
  }

  /* ---------- c1_preprocess.find_region ---------- */
  function findRegion(text) {
    const t = text || "";
    const R = D.region;
    const ext = [];
    for (const city of R.out_of_city)
      for (const x of finditer(new RegExp(reEsc(city) + "(市|省)"), t)) ext.push([x.start, x.end, city + x.m[1]]);
    const shadowed = pos => ext.some(([, end]) => end <= pos && pos <= end + 2);

    const shadowNames = new Set();
    for (const u of R.units)
      for (const name of [u.name, ...u.aliases])
        if (finditer(new RegExp(reEsc(name)), t).some(x => shadowed(x.start))) shadowNames.add(name);

    const cands = [];
    for (const u of R.units) {
      for (const town of u.towns) {
        for (const x of finditer(new RegExp(reEsc(town)), t))
          if (!shadowed(x.start)) cands.push([town.length + 100, u, town, town]);
        const short = town.endsWith("街道") ? town.slice(0, -2) : town.slice(0, -1);
        if (short.length >= 2)
          for (const x of finditer(new RegExp(reEsc(short) + "(?=镇|乡|街道|社区|村)"), t))
            if (!shadowed(x.start) && !t.includes(town)) cands.push([short.length + 50, u, town, short]);
      }
      for (const name of [u.name, ...u.aliases]) {
        if (shadowNames.has(name)) continue;
        for (const x of finditer(new RegExp(reEsc(name)), t))
          if (!shadowed(x.start)) cands.push([name.length, u, "", name]);
      }
    }
    const extNames = [...new Set(ext.map(e => e[2]))].join("、");
    if (!cands.length) {
      if (ext.length)
        return [{ unit_id: "EXT", name: extNames, dispatch: "", town: "", matched: extNames, multi: false,
                  basis: `只出现市域外地名「${extNames}」，未出现芜湖区县或乡镇街道：疑似非本市行政管辖` }, extNames];
      return [{ unit_id: "", name: "", dispatch: "", town: "", matched: "", multi: false, basis: "未匹配到芜湖区县或乡镇街道" }, ""];
    }
    cands.sort((a, b) => b[0] - a[0]); // 稳定排序，与 Python sorted 一致
    const [, u, town, hit] = cands[0];
    let units = new Set(cands.filter(c => c[0] >= 100).map(c => c[1].id));
    if (!units.size) units = new Set(cands.map(c => c[1].id));
    let basis = `命中「${hit}」→ ${u.name}` + (town ? `（${town}）` : "");
    if (units.size > 1) basis += `；文本同时涉及多个区县（${[...units].sort().join("、")}），需人工确认事发地`;
    if (ext.length) basis += `；文本同时出现市域外地名「${extNames}」，需核实事发地与被诉主体所在地`;
    return [{ unit_id: u.id, name: u.name, dispatch: u.dispatch, town, matched: hit, basis, multi: units.size > 1 },
            ext.length ? extNames : ""];
  }

  /* ---------- precheck.py ---------- */
  function guessCategory(text) {
    const scored = D.catalog.map(c => [c.kw.split(";").filter(k => k && text.includes(k)).length, c]);
    scored.sort((a, b) => b[0] - a[0]);
    return scored.filter(([s]) => s > 0).map(([, c]) => c).slice(0, 2);
  }

  function present(rid, text, pii, region) {
    switch (rid) {
      case "ELE-001": return !!(pii["手机号"] || pii["固定电话"]) || /\d{3,4}[-－]?\d{7,8}/.test(text);
      case "ELE-002": return !!region.unit_id;
      case "ELE-003": return text.replace(/\s/g, "").length >= 20;
      case "ELE-004": return RX.DEMAND.test(text);
      case "ELE-005": return RX.LOCATION_DETAIL.test(text);
      case "ELE-006": case "ELE-013": return RX.TIME_FREQ.test(text);
      case "ELE-007": case "ELE-009": return RX.SUBJECT.test(text);
      case "ELE-008": return RX.AMOUNT.test(text);
      case "ELE-010": return RX.PERIOD.test(text);
      case "ELE-011": return RX.BUS.test(text);
      case "ELE-012": return RX.PROJECT.test(text);
      case "ELE-014": return !RX.REPEAT_WORDS.test(text) || /\d{12,15}/.test(text);
      default: return true;
    }
  }

  function precheck(raw) {
    const text = (raw || "").trim();
    const [masked, pii] = mask(text);
    const [region] = findRegion(text);
    const cats = guessCategory(text);
    const major = cats.length ? cats[0].major : "";
    const minors = cats.map(c => c.minor);

    if (RX.EMERGENCY.test(text))
      return { level: "emergency", headline: "这可能是紧急险情，请先拨打 110 / 119 / 120",
               advice: "人员安全第一：先打紧急电话、远离危险区域；12345 会同步记录，但不能替代紧急救援。",
               masked, checklist: [], units: [], region };

    let boundary = { ok: true, type: "", text: "", route: "" };
    if (region.unit_id === "EXT") {
      boundary = { ok: false, type: "可能不归芜湖管",
                   text: `您描述的事发地或经营者在「${region.name}」，不在芜湖市范围内。`,
                   route: `建议拨打${region.name}当地的 12345，或拨打 12315 消费者投诉热线。` };
    } else if (RX.IN_PROCESS.test(text)) {
      boundary = { ok: false, type: "已进入法定程序", text: "您提到已经起诉、仲裁或信访，12345 不会重复转办。",
                   route: "请按法院、仲裁机构或信访部门的程序继续跟进。" };
    } else {
      const hitCivil = D.civil.find(([re]) => re.test(text));
      const civil = hitCivil ? hitCivil[1] : null;
      if (civil && !RX.ADMIN_FACT.test(text))
        boundary = { ok: false, type: "属于民事纠纷", text: `${civil}，行政部门没有权力裁决。`,
                     route: "可以先和对方协商；协商不成可找属地人民调解委员会，或申请仲裁、向法院起诉。12345 可以告诉您调解组织的联系方式。" };
      else if (civil)
        boundary = { ok: true, type: "部分属于民事纠纷",
                     text: `您的诉求里，赔偿或利息部分${civil}，12345 无法裁决；但其中的违规经营、设施损坏、安全隐患等问题，12345 可以派给主管部门处理。`,
                     route: "建议把两件事分开说清楚：要求部门处理的是什么，要求对方赔偿的是什么。" };
    }

    let units = [];
    for (const d of D.duty) {
      if (minors.includes(d.minor)) {
        let level1 = d.level1;
        if (level1.startsWith("属地")) level1 = region.dispatch || "事发地所在的区县政府";
        units.push({ minor: d.minor, level1, dept: d.dept, assist: d.assist, boundary: d.boundary });
      }
    }
    const seen = new Set();
    units = units.filter(u => { const k = u.level1 + "\u0000" + u.dept; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 3);

    const checklist = [];
    for (const r of D.elements) {
      if (r.scope !== "全部" && !r.scope.split(";").includes(major)) continue;
      if (r.id === "ELE-015" && !RX.DANGER.test(text)) continue;
      let ok = present(r.id, text, pii, region);
      if (r.id === "ELE-002" && region.unit_id === "EXT") ok = true;
      checklist.push({ id: r.id, name: r.name, ok, need: r.need, ask: r.ask, why: r.impact, example: D.examples[r.id] || "" });
    }
    const blockMissing = checklist.filter(c => !c.ok && c.need === "阻断必填");
    const suppMissing = checklist.filter(c => !c.ok && c.need !== "阻断必填");

    const tips = [];
    if (RX.MULTI.test(text)) tips.push("您好像提了不止一件事。可以一件一件说清楚，每件事希望谁来做什么——这样派单时会分别交给负责的部门，不容易漏办。");
    if (RX.REPEAT_WORDS.test(text)) tips.push("您之前反映过这件事：请准备好上次的工单号和答复内容，方便并单处理，不用从头再说一遍。");
    if (Object.keys(pii).length) tips.push("提示：您填写的手机号、身份证号等信息在这里已自动隐藏，不会显示在工单摘要里。");

    let level, headline;
    if (!boundary.ok) { level = "redirect"; headline = boundary.type; }
    else if (blockMissing.length) { level = "incomplete"; headline = `还差 ${blockMissing.length} 项关键信息，补上再提交更容易一次办成`; }
    else if (suppMissing.length) { level = "almost"; headline = `基本说清楚了，再补 ${suppMissing.length} 项会更好`; }
    else { level = "ready"; headline = "信息比较完整，可以提交了"; }

    return { level, headline, boundary, region,
             category: cats.map(c => ({ major: c.major, minor: c.minor })), units,
             checklist, block_missing: blockMissing.length, supp_missing: suppMissing.length,
             tips, masked, disclaimer: "以上为辅助提示，是否受理与派给哪个部门，以 12345 正式受理为准。" };
  }

  root.JZ = { init, precheck, mask, findRegion };
  if (typeof module !== "undefined") module.exports = root.JZ;
})(typeof window !== "undefined" ? window : globalThis);
