import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const defaultScriptPath = fileURLToPath(new URL('../scripts/windows-ocr.ps1', import.meta.url));
const defaultPowerShellPath = process.env.SystemRoot
  ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  : 'powershell.exe';
const defaultLanguages = ['zh-Hant', 'en-US'];

function unavailable(error) {
  return { available: false, error };
}

function isBounds(value) {
  return value
    && typeof value === 'object'
    && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value[key]));
}

function normalizeWord(word) {
  if (!word || typeof word.text !== 'string' || !isBounds(word.bounds)) {
    throw new Error('OCR output contains an invalid word.');
  }

  return { text: word.text, bounds: word.bounds };
}

function normalizeLine(line) {
  if (!line || typeof line.text !== 'string' || !isBounds(line.bounds) || !Array.isArray(line.words)) {
    throw new Error('OCR output contains an invalid line.');
  }

  return {
    text: line.text,
    bounds: line.bounds,
    words: line.words.map(normalizeWord),
  };
}

function parseOcrOutput(output) {
  const text = String(output).replace(/^\uFEFF/, '').trim();
  if (!text) {
    throw new Error('Windows OCR returned no JSON.');
  }

  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Windows OCR returned invalid JSON.');
  }

  if (parsed.available === false) {
    return unavailable(typeof parsed.error === 'string' && parsed.error ? parsed.error : 'Windows OCR is unavailable.');
  }

  if (parsed.available !== true || typeof parsed.language !== 'string' || typeof parsed.text !== 'string' || !Array.isArray(parsed.lines)) {
    throw new Error('Windows OCR returned an incomplete result.');
  }

  const result = {
    available: true,
    language: parsed.language,
    text: parsed.text,
    lines: parsed.lines.map(normalizeLine),
  };

  if (Number.isFinite(parsed.width)) {
    result.width = parsed.width;
  }
  if (Number.isFinite(parsed.height)) {
    result.height = parsed.height;
  }
  return result;
}

async function runPowerShell({ file, args, timeoutMs }) {
  return execFile(file, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  });
}

function outputFromRunner(value) {
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    return value;
  }
  if (value && (typeof value.stdout === 'string' || Buffer.isBuffer(value.stdout))) {
    return value.stdout;
  }
  throw new Error('OCR runner returned no stdout.');
}

function runnerFailure(error, timeoutMs) {
  if (error?.killed || error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT') {
    return unavailable(`Windows OCR timed out after ${timeoutMs} ms.`);
  }
  return unavailable('Windows OCR process could not be started.');
}

/**
 * Run Windows.Media.Ocr locally and return text with coordinates in source-image pixels.
 * `runner` is injectable for tests and receives `{ file, args, timeoutMs }`.
 */
export async function recognizeImage(imagePath, {
  languages = defaultLanguages,
  timeoutMs = 20_000,
  runner = runPowerShell,
  powershellPath = defaultPowerShellPath,
  scriptPath = defaultScriptPath,
} = {}) {
  if (typeof imagePath !== 'string' || imagePath.length === 0) {
    return unavailable('An image path is required.');
  }
  if (!Array.isArray(languages) || languages.length === 0 || languages.some((language) => typeof language !== 'string' || !language.trim())) {
    return unavailable('At least one OCR language is required.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return unavailable('OCR timeout must be a positive number of milliseconds.');
  }
  if (typeof runner !== 'function') {
    return unavailable('OCR runner is unavailable.');
  }

  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-ImagePath', imagePath,
    '-LanguagesJson', JSON.stringify(languages.map((language) => language.trim())),
  ];

  let output;
  try {
    output = outputFromRunner(await runner({ file: powershellPath, args, timeoutMs }));
  } catch (error) {
    return runnerFailure(error, timeoutMs);
  }

  try {
    return parseOcrOutput(output);
  } catch {
    return unavailable('Windows OCR returned invalid output.');
  }
}
