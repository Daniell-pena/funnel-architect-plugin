#!/usr/bin/env node
/**
 * mobile-check.js — Validates mobile responsiveness of funnel pages, with extra
 * checks for iPhone Safari (the browser most paid social traffic lands in).
 * Receives hook JSON on stdin and checks the file that was just written/edited.
 * Cross-platform replacement for mobile-check.sh (no bash or jq required).
 *
 * Usage as a hook: reads {"tool_input": {"file_path": ...}} from stdin.
 * Usage by hand:   node mobile-check.js path/to/page.html
 */

const fs = require('fs');
const path = require('path');

const FULL_PAGE_EXT = ['.html', '.htm'];
const CHECKED_EXT = [...FULL_PAGE_EXT, '.astro', '.jsx', '.tsx', '.vue', '.svelte', '.css'];

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch (err) {
        return '';
    }
}

function getFilePath() {
    if (process.argv[2]) return { file: process.argv[2], manual: true };
    const raw = readStdin();
    try {
        const input = JSON.parse(raw);
        const ti = input.tool_input || {};
        return { file: ti.file_path || ti.TargetFile || '', manual: false };
    } catch (err) {
        return { file: '', manual: false };
    }
}

// Returns [{selector, body}] for every CSS rule in the file (good enough for
// <style> blocks, .css files and most CSS-in-JS template strings).
function cssRules(content) {
    const rules = [];
    const ruleRegex = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = ruleRegex.exec(content)) !== null) {
        rules.push({ selector: m[1].trim(), body: m[2] });
    }
    return rules;
}

function pxValue(decl) {
    const m = decl.match(/font-size\s*:\s*([\d.]+)(px|rem|em)/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return m[2].toLowerCase() === 'px' ? n : n * 16;
}

function check(content, ext) {
    const issues = [];
    const isFullPage = FULL_PAGE_EXT.includes(ext) && /<head|<html/i.test(content);
    const rules = cssRules(content);

    // ── General mobile checks ────────────────────────────────────────────
    if (isFullPage && !/name=["']viewport["']/i.test(content)) {
        issues.push('Missing viewport meta tag: add <meta name="viewport" content="width=device-width, initial-scale=1.0">');
    }

    if (/(?:^|[^-])width\s*:\s*\d{4,}px/i.test(content)) {
        issues.push('Fixed widths over 999px will break on mobile. Use max-width, %, or vw units instead');
    }

    if (rules.some(r => /position\s*:\s*fixed/i.test(r.body) && /(?:^|[;\s])width\s*:\s*\d+px/i.test(r.body))) {
        issues.push('Fixed-position elements with pixel widths may cause horizontal scroll on mobile');
    }

    if (/<button|<a\s/i.test(content) && /font-size\s*:\s*(?:[0-9]|1[01])px/i.test(content)) {
        issues.push('Font sizes under 12px detected. Make sure tap targets are at least 44x44px (Apple HIG minimum)');
    }

    if (/<img/i.test(content) && !/srcset|max-width\s*:\s*100%|width\s*:\s*100%/i.test(content)) {
        issues.push('Images may not be responsive. Add max-width: 100% or srcset');
    }

    // ── iPhone Safari checks ─────────────────────────────────────────────
    // 1. Inputs under 16px make iOS Safari zoom in on focus, which breaks the
    //    layout of opt-in and checkout forms.
    const hasFormFields = /<(input|select|textarea)\b/i.test(content);
    // Only rules whose final selector part targets the field itself
    // (input, select, textarea, or .input / .form-input / .form-control style classes).
    const targetsField = selector => selector.split(',').some(part => {
        const last = part.trim().split(/[\s>+~]+/).pop() || '';
        return /^(input|select|textarea)\b/i.test(last) || /\.(?:[\w-]*-)?(input|control|field-input)\b/i.test(last);
    });
    const smallFieldRule = rules.find(r =>
        targetsField(r.selector) && pxValue(r.body) !== null && pxValue(r.body) < 16
    );
    if ((hasFormFields || ext === '.css') && smallFieldRule) {
        issues.push(`iPhone: form field font-size under 16px ("${smallFieldRule.selector.replace(/\s+/g, ' ').slice(0, 60)}"). iOS Safari zooms in when the field is tapped. Use font-size: 16px or larger on input, select and textarea`);
    }

    // 2. 100vh is taller than the visible screen on iPhone (Safari's toolbar
    //    covers the bottom), so an above-the-fold CTA can end up hidden.
    if (/100vh/i.test(content) && !/\d+(dvh|svh|lvh)/i.test(content)) {
        issues.push('iPhone: 100vh is taller than the visible screen in Safari, so content at the bottom of the hero (often the CTA) gets hidden behind the toolbar. Use 100svh or 100dvh, with 100vh as a fallback line before it');
    }

    // 3. Autoplay video on iPhone needs muted + playsinline, or it won't play
    //    (or it jumps to fullscreen).
    const videoTags = content.match(/<video\b[^>]*>/gi) || [];
    for (const tag of videoTags) {
        if (/autoplay/i.test(tag) && (!/muted/i.test(tag) || !/playsinline|playsInline/.test(tag))) {
            issues.push('iPhone: <video autoplay> needs both muted and playsinline attributes, or iOS will not autoplay it (or will force fullscreen)');
            break;
        }
    }

    // 4. Sticky bottom bars sit under the home indicator unless they pad for
    //    the safe area.
    const stickyBottom = rules.some(r =>
        /position\s*:\s*(fixed|sticky)/i.test(r.body) && /(?:^|[;\s])bottom\s*:\s*0/i.test(r.body)
    );
    if (stickyBottom && !/safe-area-inset-bottom/i.test(content)) {
        issues.push('iPhone: fixed/sticky bottom bar without safe-area padding. The home indicator will overlap it. Add padding-bottom: env(safe-area-inset-bottom) (and viewport-fit=cover in the viewport meta)');
    }
    if (/safe-area-inset/i.test(content) && isFullPage && !/viewport-fit\s*=\s*cover/i.test(content)) {
        issues.push('iPhone: env(safe-area-inset-*) is used but the viewport meta is missing viewport-fit=cover, so the insets stay at 0');
    }

    // 5. background-attachment: fixed is not supported on iOS (renders zoomed/blurry).
    if (/background-attachment\s*:\s*fixed/i.test(content)) {
        issues.push('iPhone: background-attachment: fixed does not work on iOS Safari (background renders huge and blurry). Remove it or use a fixed pseudo-element instead');
    }

    // 6. Wrong input types show the wrong keyboard, which hurts lead form completion.
    const inputTags = content.match(/<input\b[^>]*>/gi) || [];
    const badType = inputTags.find(tag => {
        const type = (tag.match(/type=["']?(\w+)/i) || [, 'text'])[1].toLowerCase();
        const hint = (tag.match(/(?:name|id|placeholder|autocomplete)=["'][^"']*["']/gi) || []).join(' ').toLowerCase();
        if (/e-?mail/.test(hint) && type !== 'email') return true;
        if (/phone|\btel\b|mobile|celular|telefono/.test(hint) && type !== 'tel') return true;
        return false;
    });
    if (badType) {
        issues.push(`iPhone: input "${badType.slice(0, 70)}" should use type="email" or type="tel" so iOS shows the right keyboard`);
    }

    return issues;
}

function main() {
    const { file, manual } = getFilePath();
    const ext = path.extname(file || '').toLowerCase();
    if (!file || !CHECKED_EXT.includes(ext) || !fs.existsSync(file)) process.exit(0);

    const content = fs.readFileSync(file, 'utf8');
    const issues = check(content, ext);
    const name = path.basename(file);

    if (manual) {
        if (issues.length === 0) console.log(`✅ Mobile/iPhone check passed for ${name}`);
        else console.log(`⚠️ Mobile/iPhone issues in ${name}:\n${issues.map(i => `• ${i}`).join('\n')}`);
        process.exit(issues.length ? 1 : 0);
    }

    if (issues.length === 0) {
        console.log(JSON.stringify({ systemMessage: `✅ Mobile/iPhone check passed for ${name}` }));
    } else {
        // decision "block" feeds the reason back to Claude so it fixes the issues.
        const text = `⚠️ Mobile/iPhone issues in ${name}:\n${issues.map(i => `• ${i}`).join('\n')}`;
        console.log(JSON.stringify({ decision: 'block', reason: text, systemMessage: text }));
    }
    process.exit(0);
}

main();
