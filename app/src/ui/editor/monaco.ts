import type * as MonacoApi from 'monaco-editor'
import { encodePathAsUrl } from '../../lib/path'
import { getMonospaceFontFamily } from '../get-monospace-font-family'

export type Monaco = typeof MonacoApi

/** The worker bundles built by the monacoWorkers webpack config. */
const workerForLabel: Record<string, string> = {
  json: 'json',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  handlebars: 'html',
  razor: 'html',
  typescript: 'ts',
  javascript: 'ts',
}

export const DesktopThemeName = 'github-desktop'

let loading: Promise<Monaco> | null = null

function cssVar(style: CSSStyleDeclaration, name: string) {
  return style.getPropertyValue(name).trim()
}

/** Convert any CSS color to the #rrggbb(aa) form Monaco themes require. */
function toHex(color: string, fallback: string) {
  const canvas = document.createElement('canvas').getContext('2d')
  if (canvas === null || color.length === 0) {
    return fallback
  }
  canvas.fillStyle = fallback
  canvas.fillStyle = color
  const value = canvas.fillStyle
  if (value.startsWith('#')) {
    return value
  }
  const match = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(
    value
  )
  if (match === null) {
    return fallback
  }
  const hex = (n: number) =>
    Math.round(n).toString(16).padStart(2, '0').slice(0, 2)
  const alpha = match[4] === undefined ? '' : hex(Number(match[4]) * 255)
  return `#${hex(+match[1])}${hex(+match[2])}${hex(+match[3])}${alpha}`
}

/** A Monaco theme made from the colors of the theme chosen in Appearance. */
function applyDesktopTheme(monaco: Monaco) {
  const style = getComputedStyle(document.body)
  const isDark = document.body.classList.contains('theme-dark')
  const color = (name: string, fallback: string) =>
    toHex(cssVar(style, name), fallback)

  const background = color('--background-color', isDark ? '#1e1e1e' : '#ffffff')
  const foreground = color('--text-color', isDark ? '#d4d4d4' : '#24292e')
  const secondary = color('--text-secondary-color', '#6a737d')
  const alt = color(
    '--box-alt-background-color',
    isDark ? '#252526' : '#f6f8fa'
  )
  const border = color('--box-border-color', isDark ? '#3c3c3c' : '#e1e4e8')
  const selection = color(
    '--box-selected-background-color',
    isDark ? '#264f78' : '#c8e1ff'
  )
  const focus = color('--focus-color', '#0366d6')

  monaco.editor.defineTheme(DesktopThemeName, {
    base: isDark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': background,
      'editor.foreground': foreground,
      'editorLineNumber.foreground': secondary,
      'editorLineNumber.activeForeground': foreground,
      'editor.lineHighlightBackground': alt,
      'editor.lineHighlightBorder': alt,
      'editor.selectionBackground': selection,
      'editorGutter.background': background,
      'editorWidget.background': alt,
      'editorWidget.border': border,
      'editorCursor.foreground': foreground,
      focusBorder: focus,
      'minimap.background': background,
      'scrollbarSlider.background': `${secondary.slice(0, 7)}40`,
    },
  })
  monaco.editor.setTheme(DesktopThemeName)
}

/**
 * Load the editor on first use: it's large, so it lives in its own chunk
 * that isn't parsed while the app starts.
 */
export function loadMonaco(): Promise<Monaco> {
  if (loading === null) {
    const env: MonacoApi.Environment = {
      getWorker: (_: string, label: string) =>
        new Worker(
          encodePathAsUrl(
            __dirname,
            `monaco/${workerForLabel[label] ?? 'editor'}.worker.js`
          ),
          { name: label }
        ),
    }
    ;(self as any).MonacoEnvironment = env

    loading = import(/* webpackChunkName: "monaco" */ 'monaco-editor').then(
      monaco => {
        applyDesktopTheme(monaco)
        new MutationObserver(() => applyDesktopTheme(monaco)).observe(
          document.body,
          { attributes: true, attributeFilter: ['class'] }
        )
        return monaco
      }
    )
  }
  return loading
}

/** Options shared by every editor so they look alike. */
export function baseEditorOptions(): MonacoApi.editor.IEditorOptions {
  return {
    fontFamily: getMonospaceFontFamily(),
    fontSize: 12,
    lineHeight: 18,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    smoothScrolling: true,
    fixedOverflowWidgets: true,
    glyphMargin: false,
    minimap: { enabled: true, renderCharacters: false },
  }
}
