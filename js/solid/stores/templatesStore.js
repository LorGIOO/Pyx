// The template library: tables, figures and file calls as plain .tex files
// in Pyx's folder (next to config.json):
//
//   templates/tables/<name>.tex     what the table assistant can write
//   templates/figures/<name>.tex    what the figure assistant (and a dropped
//                                   image) can write
//   templates/files/<kind>.tex      how a dropped / inserted file is called:
//                                   excel, csv, notebook, python, pdf,
//                                   pdf-figure, tex, bib (one file each;
//                                   extra variants: "<kind> - <variant>.tex")
//
// A template is LaTeX with {{placeholders}} that Pyx fills in:
//   tables   {{colspec}} {{colspec_v}} {{colspec_x}} {{header}} {{rows}}
//            {{rows_hline}} {{caption}} {{label}} {{ncols}}
//   figures  {{path}} {{width}} {{options}} {{caption}} {{label}}
//   files    {{path}} {{path_noext}} {{name}} {{sheet}} {{pages}} {{page}}
//            {{width}} {{caption}} {{label}}
// A line whose placeholders all come out EMPTY is left out (no \caption{}
// without a caption, no \label{tab:} without a label).
import { createSignal } from 'solid-js';
import { t } from '../../core/i18n.js';
import { readUserFile, writeUserFile, deleteUserFile, listUserFiles, fileNameOf } from '../../core/userfiles.js';

export const KINDS = ['tables', 'figures', 'files'];
const DIR = (kind) => `templates/${kind}`;
const MARK = (kind) => `templates/${kind}/.pyx-seeded`;

/* ---------------- built-in templates (written once into the folder) ---------------- */
const BUILTIN = () => ({
  tables: [
    [t('Profesional (booktabs)', 'Professional (booktabs)'), String.raw`% ${t('Necesita', 'Needs')} \usepackage{booktabs}
\begin{table}[htbp]
  \centering
  \caption{{{caption}}}
  \label{tab:{{label}}}
  \begin{tabular}{{{colspec}}}
    \toprule
    {{header}}
    \midrule
    {{rows}}
    \bottomrule
  \end{tabular}
\end{table}
`],
    [t('Cuadrícula', 'Grid'), String.raw`\begin{table}[htbp]
  \centering
  \caption{{{caption}}}
  \label{tab:{{label}}}
  \begin{tabular}{{{colspec_v}}}
    \hline
    {{header}}
    \hline
    {{rows_hline}}
    \hline
  \end{tabular}
\end{table}
`],
    [t('Filas alternas en gris', 'Alternating grey rows'), String.raw`% ${t('Necesita', 'Needs')} \usepackage[table]{xcolor} ${t('y', 'and')} \usepackage{booktabs}
\begin{table}[htbp]
  \centering
  \caption{{{caption}}}
  \label{tab:{{label}}}
  \rowcolors{2}{gray!10}{white}
  \begin{tabular}{{{colspec}}}
    \toprule
    {{header}}
    \midrule
    {{rows}}
    \bottomrule
  \end{tabular}
\end{table}
`],
    [t('Ajustada al ancho (tabularx)', 'Full width (tabularx)'), String.raw`% ${t('Necesita', 'Needs')} \usepackage{tabularx} ${t('y', 'and')} \usepackage{booktabs}
\begin{table}[htbp]
  \centering
  \caption{{{caption}}}
  \label{tab:{{label}}}
  \begin{tabularx}{\linewidth}{{{colspec_x}}}
    \toprule
    {{header}}
    \midrule
    {{rows}}
    \bottomrule
  \end{tabularx}
\end{table}
`],
    [t('Tabla larga, varias páginas (longtable)', 'Long table, several pages (longtable)'), String.raw`% ${t('Necesita', 'Needs')} \usepackage{longtable} ${t('y', 'and')} \usepackage{booktabs}
\begin{longtable}{{{colspec}}}
  \caption{{{caption}}}\label{tab:{{label}}}\\
  \toprule
  {{header}}
  \midrule
  \endfirsthead
  \toprule
  {{header}}
  \midrule
  \endhead
  \bottomrule
  \endfoot
  {{rows}}
\end{longtable}
`],
  ],
  figures: [
    [t('Centrada', 'Centred'), String.raw`\begin{figure}[htbp]
  \centering
  \includegraphics[{{options}}]{{{path}}}
  \caption{{{caption}}}
  \label{fig:{{label}}}
\end{figure}
`],
    [t('Con marco', 'Framed'), String.raw`\begin{figure}[htbp]
  \centering
  \fbox{\includegraphics[{{options}}]{{{path}}}}
  \caption{{{caption}}}
  \label{fig:{{label}}}
\end{figure}
`],
    [t('Al lado del texto (wrapfigure)', 'Beside the text (wrapfigure)'), String.raw`% ${t('Necesita', 'Needs')} \usepackage{wrapfig}
\begin{wrapfigure}{r}{0.45\textwidth}
  \centering
  \includegraphics[width=\linewidth]{{{path}}}
  \caption{{{caption}}}
  \label{fig:{{label}}}
\end{wrapfigure}
`],
    [t('A todo el ancho', 'Full width'), String.raw`\begin{figure}[htbp]
  \centering
  \includegraphics[width=\textwidth]{{{path}}}
  \caption{{{caption}}}
  \label{fig:{{label}}}
\end{figure}
`],
  ],
  files: [
    ['excel', String.raw`\hoja[{{sheet}}]{{{path}}}
`],
    ['csv', String.raw`\hoja{{{path}}}
`],
    ['notebook', String.raw`\pynotebook{{{path}}}
`],
    ['python', String.raw`\pyfile{{{path}}}
`],
    ['python - ' + t('código', 'listing'), String.raw`% ${t('Necesita', 'Needs')} \usepackage{listings}
\lstinputlisting[language=Python]{{{path}}}
`],
    ['pdf', String.raw`% ${t('Necesita', 'Needs')} \usepackage{pdfpages}
\includepdf[pages={{pages}}]{{{path}}}
`],
    ['pdf-figure', String.raw`\begin{figure}[htbp]
  \centering
  \includegraphics[page={{page}},width={{width}}]{{{path}}}
  \caption{{{caption}}}
  \label{fig:{{label}}}
\end{figure}
`],
    ['tex', String.raw`\input{{{path_noext}}}
`],
    ['bib', String.raw`\bibliography{{{path_noext}}}
`],
  ],
});

/* ---------------- filling ---------------- */
const PH = /\{\{(\w+)\}\}/g;

/** Fill a template's {{placeholders}}. A multi-line value takes the
 *  indentation of the line its placeholder is on; a line whose placeholders
 *  are all empty is dropped. */
export function fillTemplate(text, vars) {
  const out = [];
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const names = [...line.matchAll(PH)].map((m) => m[1]);
    if (names.length && names.every((n) => !String(vars[n] ?? '').trim())) continue;
    const indent = (line.match(/^\s*/) || [''])[0];
    out.push(line.replace(PH, (_, n) => {
      const v = String(vars[n] ?? '');
      return v.includes('\n') ? v.split('\n').map((l, i) => (i ? indent + l : l)).join('\n') : v;
    }));
  }
  return out.join('\n').replace(/\n+$/, '');
}

/** The placeholders a kind of template understands (for the hint line). */
export const PLACEHOLDERS = {
  tables: ['colspec', 'colspec_v', 'colspec_x', 'header', 'rows', 'rows_hline', 'caption', 'label', 'ncols'],
  figures: ['path', 'width', 'options', 'caption', 'label'],
  files: ['path', 'path_noext', 'name', 'sheet', 'pages', 'page', 'width', 'caption', 'label'],
};

/** Turn concrete code back into a template: each piece Pyx generated
 *  (the rows, the caption, the path…) becomes its placeholder again. */
export function templatize(code, pieces) {
  let s = String(code);
  // Longest first, so "rows" is replaced before a cell inside it could be.
  const entries = Object.entries(pieces)
    .filter(([, v]) => typeof v === 'string' && v.trim().length > 1)
    .sort((a, b) => b[1].length - a[1].length);
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [k, v] of entries) {
    if (!v.includes('\n')) { s = s.split(v).join(`{{${k}}}`); continue; }
    // A multi-line piece was indented line by line when it was filled in.
    const re = new RegExp(v.split('\n').map(esc).join('\\n[ \\t]*'), 'g');
    s = s.replace(re, `{{${k}}}`);
  }
  return s.endsWith('\n') ? s : s + '\n';
}

/* ---------------- library ---------------- */
const [lists, setLists] = createSignal({ tables: [], figures: [], files: [] });
export const templates = (kind) => lists()[kind] || [];

async function seed(kind) {
  if ((await readUserFile(MARK(kind))) != null) return;
  const have = await listUserFiles(DIR(kind));
  for (const [name, text] of BUILTIN()[kind]) {
    const file = fileNameOf(name);
    if (!have.includes(file)) await writeUserFile(`${DIR(kind)}/${file}`, text).catch(() => {});
  }
  await writeUserFile(MARK(kind), 'Pyx: built-in templates written once. Delete this file to write them again.\n').catch(() => {});
}

/** Read one kind's templates from the folder (writing the built-in ones the
 *  first time). Each: { name, file, text }. */
export async function loadTemplates(kind) {
  await seed(kind);
  const files = (await listUserFiles(DIR(kind))).filter((f) => /\.tex$/i.test(f));
  const list = [];
  for (const file of files) {
    const text = await readUserFile(`${DIR(kind)}/${file}`);
    if (text != null) list.push({ name: file.replace(/\.tex$/i, ''), file, text });
  }
  setLists({ ...lists(), [kind]: list });
  return list;
}

export async function saveTemplate(kind, name, text) {
  const file = fileNameOf(name);
  await writeUserFile(`${DIR(kind)}/${file}`, text);
  return loadTemplates(kind);
}

export async function deleteTemplate(kind, name) {
  await deleteUserFile(`${DIR(kind)}/${fileNameOf(name)}`);
  return loadTemplates(kind);
}

/** The text of the file template for a kind of file ('excel', 'pdf'…), the
 *  user's if there is one, else the built-in one. A variant: 'python - listing'. */
export async function fileTemplate(kind) {
  const list = templates('files').length ? templates('files') : await loadTemplates('files');
  const hit = list.find((x) => x.name.toLowerCase() === kind.toLowerCase());
  if (hit) return hit.text;
  const b = BUILTIN().files.find(([n]) => n.toLowerCase() === kind.toLowerCase());
  return b ? b[1] : '';
}

/** The file templates for one kind of file: the main one and its variants. */
export function fileVariants(kind) {
  return templates('files').filter((x) => {
    const n = x.name.toLowerCase();
    return n === kind || n.startsWith(kind + ' - ');
  });
}
