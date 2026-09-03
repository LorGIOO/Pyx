import { describe, it, expect, beforeEach } from 'vitest';
import { relativeTo, joinPath, dirOf, baseName, stemOf } from '../js/core/paths.js';
import {
  setBuildMaps, buildPathToSource, sourceToBuildPath, lineMapFor,
  projectRoot, workingDir,
} from '../js/compile/build-maps.js';

const PROJ = 'C:/Users/ana/Proyecto';
const WORK = 'C:/Users/ana/AppData/Local/Pyx/build/_Proyecto-00ff';

beforeEach(() => setBuildMaps({ project: PROJ, work: WORK }));

describe('relativeTo', () => {
  it('gives the path under the base, with forward slashes', () => {
    expect(relativeTo(PROJ, PROJ + '/cap/documento1.pltx')).toBe('cap/documento1.pltx');
    expect(relativeTo('C:\\a\\b', 'C:\\a\\b\\c\\d.tex')).toBe('c/d.tex');
  });
  it('ignores separator style and case, which is what Windows needs', () => {
    expect(relativeTo('C:/A/B', 'c:\\a\\b\\x.tex')).toBe('x.tex');
  });
  it('is empty for the base itself', () => {
    expect(relativeTo(PROJ, PROJ)).toBe('');
  });
  it('is null for a path outside the base', () => {
    // A chapter reached with ../shared: it needs a flattened name instead.
    expect(relativeTo(PROJ, 'C:/Users/ana/Compartido/cap.tex')).toBe(null);
    expect(relativeTo(PROJ, 'C:/Users/ana/ProyectoViejo/x.tex')).toBe(null);
  });
  it('does not blow up on missing arguments', () => {
    expect(relativeTo(null, 'x')).toBe(null);
    expect(relativeTo('x', null)).toBe(null);
  });
});

describe('source ↔ working directory', () => {
  it('maps a source file to the copy the engine compiles', () => {
    expect(sourceToBuildPath(PROJ + '/_Proyecto.pltx')).toBe(WORK + '/_Proyecto.build.tex');
    expect(sourceToBuildPath(PROJ + '/cap/documento1.pltx'))
      .toBe(WORK + '/cap/documento1.build.tex');
    expect(sourceToBuildPath(PROJ + '/cap/otro.tex')).toBe(WORK + '/cap/otro.build.tex');
  });

  it('maps an engine-reported path back to the project', () => {
    // This is the SyncTeX inverse-search path: the engine reports a file in the
    // working directory and the editor has to open the real source.
    expect(buildPathToSource(WORK + '/cap/documento1.build.tex'))
      .toEqual({ dir: PROJ, stem: 'cap/documento1' });
    expect(buildPathToSource(WORK + '\\_Proyecto.build.tex'))
      .toEqual({ dir: PROJ, stem: '_Proyecto' });
  });

  it('round-trips every file of a nested project', () => {
    for (const rel of ['_Proyecto', 'cap/documento1', 'cap/sub/documento2']) {
      const build = sourceToBuildPath(`${PROJ}/${rel}.pltx`);
      expect(buildPathToSource(build)).toEqual({ dir: PROJ, stem: rel });
    }
  });

  it('refuses paths that are not ours', () => {
    expect(buildPathToSource('C:/otro/sitio/x.build.tex')).toBe(null);
    expect(sourceToBuildPath('C:/fuera/x.tex')).toBe(null);
  });

  it('is null before any compile has published a workspace', () => {
    setBuildMaps({});
    expect(sourceToBuildPath(PROJ + '/a.pltx')).toBe(null);
    expect(buildPathToSource(WORK + '/a.build.tex')).toBe(null);
    expect(projectRoot()).toBe(null);
    expect(workingDir()).toBe(null);
  });
});

describe('lineMapFor', () => {
  it('finds a document map by its build basename', () => {
    setBuildMaps({ project: PROJ, work: WORK, lineMaps: { '_proyecto.build.tex': [1, 5, 9] } });
    expect(lineMapFor(PROJ + '/_Proyecto.pltx')).toEqual([1, 5, 9]);
    expect(lineMapFor(PROJ + '/otro.pltx')).toBe(null);
  });
});

describe('path helpers used to place build files', () => {
  it('joins keeping the directory separator style', () => {
    expect(joinPath('C:/a/b', 'c.tex')).toBe('C:/a/b/c.tex');
    expect(joinPath('C:\\a\\b', 'c.tex')).toBe('C:\\a\\b\\c.tex');
  });
  it('splits directory, name and stem', () => {
    expect(dirOf('C:/a/b/c.tex')).toBe('C:/a/b');
    expect(baseName('C:/a/b/c.tex')).toBe('c.tex');
    expect(stemOf('C:/a/b/c.build.tex')).toBe('c.build');
  });
});
