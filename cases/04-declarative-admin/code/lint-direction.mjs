#!/usr/bin/env node
/**
 * Direction guard.
 *
 * The console ships in both writing directions, so a physical Tailwind utility
 * is a latent bug: `pl-4`, `mr-2`, `text-right`, `border-l`, `rounded-r` all
 * pin an edge to the left or the right of the viewport instead of the start or
 * the end of the text flow. None of them fails to compile, and none of them
 * looks wrong to a left-to-right reader, which is exactly why this runs in CI.
 *
 * Logical replacements: pl/pe, ms/me, start/end, text-start/text-end,
 * border-s/border-e, rounded-s/rounded-e, ...
 *
 * Opt a single line out with a trailing `direction-lint-ignore` comment.
 *
 *   node scripts/lint-direction.mjs [--fix] [dir…]     (default: src)
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXTENSIONS = new Set(['.svelte', '.ts', '.js', '.css', '.html']);
const SKIP_DIRS = new Set(['node_modules', 'generated', '.svelte-kit']);
const IGNORE_MARK = 'direction-lint-ignore';

const PHYSICAL = [
	/^(?:pl|pr|ml|mr|left|right)-.+$/,
	/^scroll-(?:ml|mr|pl|pr)-.+$/,
	/^(?:border|rounded)-(?:l|r|tl|tr|bl|br)(?:-.+)?$/,
	/^(?:text|float|clear)-(?:left|right)$/,
	/^origin-(?:top-left|top-right|bottom-left|bottom-right|left|right)$/
];

const REPLACEMENTS = {
	pl: 'ps',
	pr: 'pe',
	ml: 'ms',
	mr: 'me',
	left: 'start',
	right: 'end',
	'text-left': 'text-start',
	'text-right': 'text-end',
	'border-l': 'border-s',
	'border-r': 'border-e',
	'rounded-l': 'rounded-s',
	'rounded-r': 'rounded-e',
	'rounded-tl': 'rounded-ss',
	'rounded-tr': 'rounded-se',
	'rounded-bl': 'rounded-es',
	'rounded-br': 'rounded-ee'
};

const REPLACEMENT_ORDER = Object.entries(REPLACEMENTS).sort((a, b) => b[0].length - a[0].length);

/** Drop a variant prefix (`sm:`, `data-[x=y]:`, `group-hover/a:`), plus `!` and a leading `-`. */
export function bareUtility(token) {
	let depth = 0;
	let cut = 0;
	for (let i = 0; i < token.length; i++) {
		const ch = token[i];
		if (ch === '[' || ch === '(') depth++;
		else if (ch === ']' || ch === ')') depth--;
		else if (ch === ':' && depth === 0) cut = i + 1;
	}
	return token.slice(cut).replace(/^!/, '').replace(/!$/, '').replace(/^-/, '');
}

export function isPhysical(token) {
	const bare = bareUtility(token);
	return PHYSICAL.some((re) => re.test(bare));
}

/** Logical replacement for a flagged token (prefix and modifiers preserved), or null. */
export function logicalise(token) {
	const bare = bareUtility(token);
	const at = token.lastIndexOf(bare);
	for (const [from, to] of REPLACEMENT_ORDER) {
		if (bare === from || bare.startsWith(`${from}-`)) {
			return token.slice(0, at) + to + token.slice(at + from.length);
		}
	}
	return null;
}

/** Candidate class tokens on a line: split on whitespace, quotes, backticks, braces and commas. */
export function offences(line) {
	if (line.includes(IGNORE_MARK)) return [];
	return line
		.split(/[\s'"`{},]+/)
		.filter((t) => t && /^[!*@\w[(-]/.test(t) && isPhysical(t));
}

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path, out);
		else if (EXTENSIONS.has(extname(name)) && !name.includes('.test.')) out.push(path);
	}
	return out;
}

function main() {
	const args = process.argv.slice(2);
	const fix = args.includes('--fix');
	const roots = args.filter((a) => a !== '--fix');
	const files = (roots.length ? roots : ['src']).flatMap((r) => walk(r));
	let problems = 0;

	for (const file of files) {
		const source = readFileSync(file, 'utf8');
		const eol = source.includes('\r\n') ? '\r\n' : '\n';
		let changed = false;

		const lines = source.split(/\r?\n/).map((line, i) => {
			let out = line;
			for (const token of offences(line)) {
				const hint = logicalise(token);
				if (fix && hint) {
					out = out.replace(token, hint);
					changed = true;
					continue;
				}
				problems++;
				console.log(
					`${relative(process.cwd(), file)}:${i + 1}  physical "${token}"` +
						(hint ? ` → use "${hint}"` : '')
				);
			}
			return out;
		});

		if (changed) writeFileSync(file, lines.join(eol));
	}

	if (problems) {
		console.log(`\n✖ ${problems} physical direction utilit${problems === 1 ? 'y' : 'ies'} found.`);
		process.exit(1);
	}
	console.log('✔ No physical direction utilities found.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
