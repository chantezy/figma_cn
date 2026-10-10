#!/usr/bin/env node
/**
 * 把上游 FigmaCN 的汉化引擎和词库同步到 vendor/figmacn/。
 *
 *   npm run sync-dict            有更新就写盘
 *   npm run sync-dict -- --dry-run   只看差异，一个字节都不写
 *
 * ── 为什么不能简单 curl 两个固定 URL ──────────────────────────────────────
 *
 * 上游改过一次目录结构：js/ 整体挪到了 src/js/。写死 URL 的同步脚本会在那次
 * 改动之后一直 404，而 404 很容易被当成「网络抖动」忽略掉，于是词库悄悄停在
 * 旧版本上 —— 汉化看起来还在工作，只是新功能的界面是英文的。
 *
 * 所以这里走 GitHub 的 git trees API，**按文件名去找真实路径**，路径换了也能跟上；
 * 真的找不到就明确报「上游结构变了」，而不是静默失败。
 *
 * ── 为什么用 git blob sha 而不是比对文件内容 ──────────────────────────────
 *
 * GitHub 的 contents API 会直接给出 blob 的 sha，而 git 的 blob sha 只由内容决定
 * （sha1("blob <字节数>\0" + 内容)），本地用同一条公式算出来就能直接比。一样就
 * 说明**逐字节相同**，不需要下载整个词库，也不会因为换行符/编码差异误判成有更新。
 * 这一点很重要：这个脚本「看起来更新了其实没变」比「没更新」更糟 ——
 * 前者会让人以为同步是有效的。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor', 'figmacn');
const REPO = 'Figma-Cool/figmaCN';

const DRY_RUN = process.argv.includes('--dry-run');

/** 要同步的文件：本地文件名 -> 期望的上游文件名 */
const TARGETS = [
  { local: 'content.js', remote: 'content.js', kind: 'engine' },
  { local: 'translations.json', remote: 'translations.json', kind: 'dict' },
  { local: 'LICENSE', remote: 'LICENSE', kind: 'license' },
];

// --------------------------------------------------------------------- 工具

function gitBlobSha(buf) {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

function localSha(file) {
  try {
    return gitBlobSha(fs.readFileSync(path.join(VENDOR, file)));
  } catch {
    return null;
  }
}

async function api(url) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'figma-cn-sync-dict' };
  // 没配 token 也能用，只是受 60 次/小时 的匿名限额；配了就宽松得多
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const res = await fetch(url, { headers });
  if (res.status === 403 || res.status === 429) {
    throw new Error(`GitHub 接口限流了（${res.status}）。设置 GITHUB_TOKEN 环境变量可以提高额度。`);
  }
  if (!res.ok) {
    throw new Error(`GitHub 接口返回 ${res.status}：${url}`);
  }
  return res.json();
}

// ------------------------------------------------------- 找出上游的真实路径

/**
 * 在上游仓库里按文件名定位目标文件。
 * 不写死 js/ 或 src/js/ —— 上游挪目录是本脚本存在的首要理由。
 */
async function locateFiles() {
  const repo = await api(`https://api.github.com/repos/${REPO}`);
  const branch = repo.default_branch;

  const tree = await api(`https://api.github.com/repos/${REPO}/git/trees/${branch}?recursive=1`);
  if (tree.truncated) {
    console.warn('⚠️  上游仓库文件树过大被截断，探测结果可能不完整。');
  }

  const blobs = tree.tree.filter((e) => e.type === 'blob');
  const found = {};

  for (const t of TARGETS) {
    // 取路径最浅的同名文件，避开 examples/ 之类的副本
    const hits = blobs
      .filter((e) => path.basename(e.path) === t.remote)
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
    if (hits.length > 0) found[t.remote] = { path: hits[0].path, sha: hits[0].sha };
  }

  return { branch, found };
}

// ------------------------------------------------------------------ 校验

/**
 * 写盘之前必须过的关卡。
 *
 * 这个脚本会覆盖 vendor/ 里的文件，而这些文件是**汉化唯一的数据来源**。
 * 上游哪天把引擎重构成别的入口函数，无脑覆盖的结果是注入脚本找不到
 * initializeTranslation、静默 return，整个 App 变回英文界面 —— 而且不报错。
 * 宁可在这里报错停手，也不要写进去一个装不上的引擎。
 */
function validateEngine(text) {
  const problems = [];
  if (!/function\s+initializeTranslation\s*\(/.test(text)) {
    problems.push('找不到 `function initializeTranslation(` 定义');
  }
  if (!/loadTranslationData\s*\(\s*\)\s*;/.test(text)) {
    problems.push('找不到自动执行的 `loadTranslationData();` 调用');
  }
  return problems;
}

function validateDict(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { problems: [`不是合法 JSON：${err.message}`], count: 0 };
  }
  if (!Array.isArray(data)) return { problems: ['顶层不是数组'], count: 0 };
  if (data.length === 0) return { problems: ['词条数组是空的'], count: 0 };

  // 每个词条应当是 [英文, 中文] 这种成对形式
  const bad = data.findIndex((row) => !Array.isArray(row) || row.length < 2);
  if (bad !== -1) {
    return { problems: [`第 ${bad + 1} 条不是 [原文, 译文] 结构：${JSON.stringify(data[bad]).slice(0, 80)}`], count: data.length };
  }
  return { problems: [], count: data.length };
}

function validateLicense(text) {
  return text.includes('GNU GENERAL PUBLIC LICENSE')
    ? []
    : ['内容看起来不是 GPL 许可证正文'];
}

// --------------------------------------------------------------- 主流程

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

async function main() {
  console.log(`上游仓库：${REPO}`);
  const { branch, found } = await locateFiles();
  console.log(`默认分支：${branch}\n`);

  for (const t of TARGETS) {
    if (!found[t.remote]) {
      fail(
        `上游结构变了：在 ${REPO}@${branch} 里找不到名为 ${t.remote} 的文件。\n` +
          `  这多半意味着上游又调整了目录结构。请人工确认新位置后更新本脚本的探测逻辑，\n` +
          `  在确认之前不要手动覆盖 vendor/figmacn/${t.local}。`
      );
    }
  }

  // 先全部下载并校验，任何一项不过就整体中止 —— 避免写入一半。
  const staged = [];
  let changed = 0;

  for (const t of TARGETS) {
    const remote = found[t.remote];
    const before = localSha(t.local);

    if (before === remote.sha) {
      console.log(`= ${t.local.padEnd(20)} 已是最新  (${remote.sha.slice(0, 10)}  ${remote.path})`);
      continue;
    }

    console.log(`↑ ${t.local.padEnd(20)} 有更新    (${String(before).slice(0, 10)} → ${remote.sha.slice(0, 10)}  ${remote.path})`);
    changed++;

    const blob = await api(`https://api.github.com/repos/${REPO}/git/blobs/${remote.sha}`);
    if (blob.encoding !== 'base64') {
      fail(`上游返回了非 base64 的 blob（encoding=${blob.encoding}），无法处理。`);
    }
    const text = Buffer.from(blob.content, 'base64').toString('utf8');

    const problems =
      t.kind === 'engine' ? validateEngine(text)
      : t.kind === 'dict' ? validateDict(text).problems
      : validateLicense(text);

    if (problems.length > 0) {
      fail(
        `上游的 ${remote.path} 没能通过校验，已中止，vendor/ 未被改动：\n` +
          problems.map((p) => `    - ${p}`).join('\n') +
          `\n  这一步是故意拦你的：写进去一个装不上的引擎，表现是整个 App 静默变回英文。\n` +
          `  请先人工看过这个文件，确认新的入口函数后再改 vendor/。`
      );
    }

    staged.push({ ...t, text, sha: remote.sha });
  }

  if (changed === 0) {
    console.log('\n✓ 本地词库和引擎与上游一致，未做任何改动。');
    return;
  }

  if (DRY_RUN) {
    console.log(`\n• --dry-run：以上 ${changed} 个文件有更新，但没有写盘。`);
    return;
  }

  // 校验全过了才开始写，且逐个走「临时文件 + rename」，
  // 中途断电也不会留下半截的文件。
  for (const item of staged) {
    const dest = path.join(VENDOR, item.local);
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, item.text, 'utf8');
    fs.renameSync(tmp, dest);

    if (item.kind === 'dict') {
      console.log(`\n✓ 已更新 ${item.local}：词条 ${validateDict(item.text).count} 条`);
    } else {
      console.log(`\n✓ 已更新 ${item.local} (${item.sha.slice(0, 10)})`);
    }
  }

  console.log(
    '\n注意：vendor/figmacn/ 是 GPL-3.0 的上游代码副本，改动会进入发布产物，\n' +
      '      LICENSE 请一并保留。改动内容建议在这一步之后看一眼 diff 再提交。'
  );
}

main().catch((err) => fail(err.message));
