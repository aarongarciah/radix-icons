import { Headers } from 'node-fetch';
import * as prettier from 'prettier';
import isOnline from 'is-online';
import * as tempy from 'tempy';
import * as fs from 'fs-extra';
import cheerio from 'cheerio';
import * as path from 'path';
import * as _ from 'lodash';
import * as ejs from 'ejs';
import execa from 'execa';
import { FILE_PATH_MANIFEST, FILE_PATH_ENTRY, FILE_PATH_TYPES } from './consts';
import {
  CodedError,
  ERRORS,
  IFigmaConfig,
  IIcons,
  IIconsSvgUrls,
  IIconManifest,
  IIcon,
  IDiffSummary,
  ITemplateIcon,
  IFigmaCanvas,
  IFigmaDocument,
  IFigmaFileImageResponse,
  IFigmaFileResponse,
} from './types';
import { getSvgo, fetch, pushObjLeafNodesToArr, handleError } from './utils';
import chalk from 'chalk';

const transformers = {
  /**
   * Pass SVG through SVGO to reduce size.
   */
  async passSVGO(svgRaw: string) {
    const svgo = getSvgo();
    const { data } = await svgo.optimize(svgRaw);
    return data as string;
  },

  /**
   * Swaps out all colors (except for "non") for stroke and fill to "currentColor".
   */
  injectCurrentColor(svgRaw: string) {
    const $ = cheerio.load(svgRaw, { xmlMode: true });
    $('*').each((i, el) => {
      Object.keys(el.attribs).forEach(attrKey => {
        if (['fill', 'stroke'].includes(attrKey)) {
          const val = $(el).attr(attrKey);
          if (val !== 'none') {
            $(el).attr(attrKey, 'currentColor');
          }
        }
      });
    });

    return $.xml();
  },

  prettify(svgRaw: string) {
    const prettierOptions = prettier.resolveConfig.sync(process.cwd());
    return prettier.format(svgRaw, { ...prettierOptions, parser: 'html' });
  },

  readyForJSX(svgRaw: string) {
    const $ = cheerio.load(svgRaw, { xmlMode: true });
    $('*').each((i, el) => {
      Object.keys(el.attribs).forEach(attrKey => {
        if (attrKey.includes('-')) {
          $(el)
            .attr(_.camelCase(attrKey), el.attribs[attrKey])
            .removeAttr(attrKey);
        }
        if (attrKey === 'class') {
          $(el)
            .attr('className', el.attribs[attrKey])
            .removeAttr(attrKey);
        }
      });
    });

    return $('svg')
      .attr('props', '...')
      .toString()
      .replace(/stroke=['|"]currentColor['|"]/g, 'stroke={color}')
      .replace(/fill=['|"]currentColor['|"]/g, 'fill={color}')
      .replace('props="..."', '{...props}');
  },
};

const labelling = {
  typeFromFrameNodeName(nodeName: string): string {
    return path.dirname(nodeName);
  },
  sizeFromFrameNodeName(nodeName: string): string {
    // Note: We ensure ordering by assignment-time in the object, and avoid numerical
    // key ordering, by adding a non-numerical to the key.
    return labelling.addSizePrefix(path.basename(nodeName));
  },
  filePathFromIcon(icon: IIcon): string {
    return path.join(icon.type, labelling.stripSizePrefix(icon.size), `${icon.name}.svg`);
  },
  stripSizePrefix(size) {
    return size.replace(/^:?(.*)/, '$1');
  },
  addSizePrefix(size) {
    return `:${size.replace(/^(:?)(.*)/, '$2')}`;
  },
};

let currentTempDir = tempy.directory();

let currentListOfAddedFiles = [];

export async function prechecks() {
  /* We can't work offline. */
  isOnline().then(isOn => {
    if (!isOn) {
      throw new CodedError(
        ERRORS.NETWORK_OFFLINE,
        'An internet connection is required to find and render Icons.',
        true
      );
    }
  });

  /* We don't want to end up deleted work-in-progress. */
  const [{ stdout: trackedFiles }, { stdout: untrackedFiles }] = await Promise.all([
    // Checks for uncommitted changes.
    execa('git', ['diff-index', 'HEAD', './']),
    // Checks for untracked files.
    execa('git', ['ls-files', '--others', '--exclude-standard', './']),
  ]);
  if (trackedFiles.length > 0 || untrackedFiles.length > 0) {
    handleError(
      new CodedError(
        ERRORS.DIRTY_WORKING_DIR,
        'There are uncommitted or untracked files in the working directory.\nPlease commit, stash, or remove them. Then try again.',
        true
      ),
      false
    );
    console.error(`
${chalk.bold('Git Status')} ${chalk.dim(
      `(${['--no-renames', '--untracked-files', '--short', '--', './'].join(' ')})`
    )}
`);
    await execa('git', ['status', '--no-renames', '--untracked-files', '--short', '--', './'], {
      stdio: 'inherit',
    });
    process.exit(1);
  }
}

export function createFigmaConfig(fileKey: string): IFigmaConfig {
  return {
    baseUrl: 'https://api.figma.com',
    fileKey,
    headers: new Headers({
      'X-Figma-Token': process.env.FIGMA_ACCESS_TOKEN,
    }),
  };
}

export async function getFigmaDocument(config: IFigmaConfig): Promise<IFigmaDocument> {
  const resp = await fetch(`${config.baseUrl}/v1/files/${config.fileKey}`, {
    headers: config.headers,
  });
  const data = (await resp.json()) as IFigmaFileResponse;
  if (data.status === 403 && data.err === 'Invalid token') {
    throw new CodedError(
      ERRORS.FIGMA_API,
      'An invalid token was used. Follow the Auth Guide (https://git.io/fjBfF), and try again.'
    );
  }
  return data.document;
}

export async function renderIdsToSvgs(ids: string[], config: IFigmaConfig): Promise<IIconsSvgUrls> {
  const resp = await fetch(`${config.baseUrl}/v1/images/${config.fileKey}?ids=${ids}&format=svg`, {
    headers: config.headers,
  });

  // We can't be sure the response, when an error, will have a body that can be streamed to JSON.
  let data: IFigmaFileImageResponse = {
    err: null,
    images: {},
  };
  if (resp.headers.get('content-type').includes('application/json')) {
    data = (await resp.json()) as IFigmaFileImageResponse;
  }
  const error = typeof data.err === 'object' ? JSON.stringify(data.err, null, 2) : data.err;

  if (!resp.ok) {
    switch (resp.status) {
      case 400:
        throw new CodedError(
          ERRORS.FIGMA_API,
          `Unexpected error encountered from Figma API\n${error}`
        );
      case 404:
        throw new CodedError(
          ERRORS.FIGMA_API,
          "One or more of the icons couldn't be found in Figma. Check to see if they still exist, and try again."
        );
      case 500:
        throw new CodedError(ERRORS.FIGMA_API, 'Figma could not render the icons. ಠ_ಠ');
      default:
        throw new CodedError(
          ERRORS.UNEXPECTED,
          `An error occured while rendering icons to SVG.\n${resp.status}\n${error}`
        );
    }
  }

  if (!data.images || !Object.keys(data.images).length) {
    throw new CodedError(
      ERRORS.UNEXPECTED,
      `An error occured after rendering icons in Figma. Render response:\n${JSON.stringify(
        data,
        null,
        2
      )}`
    );
  }

  return data.images;
}

export function getIconsPage(document: IFigmaDocument): IFigmaCanvas | null {
  const canvas = document.children.find(page => page.name.toLowerCase() === 'icons');

  return canvas && canvas.type === 'CANVAS' ? canvas : null;
}

export function getIcons(iconsCanvas: IFigmaCanvas): IIcons {
  return iconsCanvas.children.reduce((icons: IIcons, iconSetNode) => {
    // We technically don't want icon sets to be in Groups, but we should still allow it
    if (iconSetNode.type === 'FRAME' || iconSetNode.type === 'GROUP') {
      iconSetNode.children.forEach(iconNode => {
        // Our individual icons frames may be Figma "Components" 🤙
        if (iconNode.type === 'FRAME' || iconNode.type === 'COMPONENT') {
          icons[iconNode.id] = {
            id: iconNode.id,
            name: iconNode.name,
            size: labelling.sizeFromFrameNodeName(iconSetNode.name),
            type: labelling.typeFromFrameNodeName(iconSetNode.name),
          };
        }
      });
    }
    return icons;
  }, {});
}

export async function downloadSvgsToFs(urls: IIconsSvgUrls, icons: IIcons, onProgress: () => void) {
  await Promise.all(
    Object.keys(urls).map(async iconId => {
      const processedSvg = await (await fetch(urls[iconId]))
        .text()
        .then(async svgRaw => transformers.passSVGO(svgRaw))
        .then(svgRaw => transformers.injectCurrentColor(svgRaw))
        .then(svgRaw => transformers.prettify(svgRaw));

      const filePath = path.resolve(currentTempDir, labelling.filePathFromIcon(icons[iconId]));
      await fs.outputFile(filePath, processedSvg, { encoding: 'utf8' });
      currentListOfAddedFiles.push(filePath);
      onProgress();
    })
  );
}

export function iconsToManifest(icons: IIcons): IIconManifest {
  return Object.keys(icons).reduce((iconManifest: IIconManifest, iconId) => {
    const icon = icons[iconId];

    if (!iconManifest[icon.type]) {
      iconManifest[icon.type] = {};
    }
    if (!iconManifest[icon.type][icon.size]) {
      iconManifest[icon.type][icon.size] = {};
    }
    if (!iconManifest[icon.type][icon.size][icon.name]) {
      iconManifest[icon.type][icon.size][icon.name] = labelling.filePathFromIcon(icon);
    }

    return iconManifest;
  }, {});
}

export function iconsToSvgPaths(icons: IIcons) {
  return Object.keys(icons).map(iconId => labelling.filePathFromIcon(icons[iconId]));
}

export function filePathToSVGinJSXSync(filePath: string) {
  const absFilePath = path.resolve(currentTempDir, filePath);
  const svgRaw = fs.readFileSync(absFilePath, { encoding: 'utf8' });
  return transformers.readyForJSX(svgRaw);
}

export async function generateReactComponents(icons: IIcons) {
  const getTemplateSource = templateFile =>
    fs.readFile(path.resolve(__dirname, './templates/', templateFile), {
      encoding: 'utf8',
    });
  const templates = {
    entry: await getTemplateSource('entry.tsx.ejs'),
    icon: await getTemplateSource('named-icon.tsx.ejs'),
    types: await getTemplateSource('types.tsx'),
  };
  const firstIcon = Object.values(icons)[0];
  const iconsWithVariants = Object.values<ITemplateIcon>(
    Object.keys(icons).reduce((iconsWithVariants: { [name: string]: ITemplateIcon }, iconId) => {
      const icon = iconsWithVariants[icons[iconId].name] || {
        name: icons[iconId].name,
        ids: [],
        sizes: [],
        types: [],
      };
      icon.ids = _.uniq(icon.ids.concat(icons[iconId].id));
      icon.sizes = _.uniq(icon.sizes.concat(labelling.stripSizePrefix(icons[iconId].size)));
      icon.types = _.uniq(icon.types.concat(icons[iconId].type));

      iconsWithVariants[icons[iconId].name] = icon;

      return iconsWithVariants;
    }, {})
  );

  const templateHelpers = {
    getDefaultSize() {
      return labelling.stripSizePrefix(firstIcon.size);
    },
    getDefaultType() {
      return firstIcon.type;
    },
    iconToComponentName(icon: ITemplateIcon) {
      const pascal = str => _.upperFirst(_.camelCase(str));
      return `${pascal(icon.name)}Icon`;
    },
    iconToPropsName(icon: ITemplateIcon) {
      return `${templateHelpers.iconToComponentName(icon)}Props`;
    },
    iconToReactFileName(icon: ITemplateIcon) {
      return `${templateHelpers.iconToComponentName(icon)}.tsx`;
    },
    iconToSVGSourceAsJSX(icon: ITemplateIcon, size: string, type: string) {
      const filePath = labelling.filePathFromIcon({
        id: icon.ids[0],
        name: icon.name,
        size,
        type,
      });
      return filePathToSVGinJSXSync(filePath);
    },
    iconHasSizeAndType(icon: ITemplateIcon, size: string, type: string) {
      return icon.ids.some(iconId => {
        const prefixedSize = labelling.addSizePrefix(size);
        return icons[iconId].size === prefixedSize && icons[iconId].type === type;
      });
    },
    stripExtension(fileName) {
      return fileName.replace(/(.*)\.\w+$/, '$1');
    },
  };

  const prettierOptions = prettier.resolveConfig.sync(process.cwd());
  /* Generate Icon Component Modules */
  for (const i in iconsWithVariants) {
    const icon = iconsWithVariants[i];
    let iconSourceRaw = await ejs.render(templates.icon, {
      icon,
      ...templateHelpers,
    });
    const iconSource = prettier.format(iconSourceRaw, {
      ...prettierOptions,
      parser: 'typescript',
    });
    const iconComponentFilePath = path.resolve(
      currentTempDir,
      'src/',
      templateHelpers.iconToReactFileName(icon)
    );
    await fs.outputFile(iconComponentFilePath, iconSource);
    currentListOfAddedFiles.push(iconComponentFilePath);
  }

  /* Generate Entry Module */
  let entrySourceRaw = await ejs.render(templates.entry, {
    icons: iconsWithVariants,
    ...templateHelpers,
  });
  const entrySource = prettier.format(entrySourceRaw, {
    ...prettierOptions,
    parser: 'typescript',
  });
  const entryFilePath = path.resolve(currentTempDir, FILE_PATH_ENTRY);
  await fs.outputFile(entryFilePath, entrySource);
  currentListOfAddedFiles.push(entryFilePath);

  /* Generate Type Modules */
  const typeDepsFilePath = path.resolve(currentTempDir, FILE_PATH_TYPES);
  await fs.outputFile(typeDepsFilePath, templates.types);
  currentListOfAddedFiles.push(typeDepsFilePath);
}

export async function getCurrentIconManifest(): Promise<IIconManifest> {
  const { stdout: gitRootDir } = await execa('git', ['rev-parse', '--show-toplevel']);
  const gitRelativePathToManifest = path.relative(
    gitRootDir,
    path.resolve(process.cwd(), FILE_PATH_MANIFEST)
  );
  let { stdout: currentManifest } = await execa('git', [
    'show',
    `HEAD:${gitRelativePathToManifest}`,
  ]);
  return JSON.parse(currentManifest);
}

export async function generateIconManifest(icons: IIcons) {
  const iconManifestFilePath = path.resolve(currentTempDir, FILE_PATH_MANIFEST);
  const iconManifest = iconsToManifest(icons);
  let iconManifestRaw = JSON.stringify(iconManifest);
  const prettierOptions = prettier.resolveConfig.sync(process.cwd());
  iconManifestRaw = prettier.format(iconManifestRaw, {
    ...prettierOptions,
    parser: 'json',
  });
  const previousIconManifest = await getCurrentIconManifest();
  await fs.writeFile(iconManifestFilePath, iconManifestRaw, {
    encoding: 'utf8',
  });
  currentListOfAddedFiles.push(iconManifestFilePath);
  return [previousIconManifest, iconManifest];
}

export async function swapGeneratedFiles(
  previousIconManifest: IIconManifest,
  nextIconManifest: IIconManifest
): Promise<string[]> {
  /* We must find all dirs and files that were generated, and remove them: */
  let generatedFilePaths = [];
  //  1. The top-level dirs for previous SVGs
  pushObjLeafNodesToArr(previousIconManifest, generatedFilePaths);
  //  2. The top-level dirs needed for new SVGs
  pushObjLeafNodesToArr(nextIconManifest, generatedFilePaths);
  //  3. The top-level dirs for generated source
  generatedFilePaths = generatedFilePaths.concat([FILE_PATH_ENTRY, FILE_PATH_TYPES]);
  const topLevelDirs: string[] = _.uniq(
    generatedFilePaths.map(filePath => filePath.replace(/^([\w-]+).*/, '$1'))
  );
  for (const i in topLevelDirs) {
    const topLevelDir = topLevelDirs[i];
    await fs.remove(path.resolve(process.cwd(), topLevelDir));
  }
  //  4. The manifest file
  await fs.remove(path.resolve(process.cwd(), FILE_PATH_MANIFEST));

  /* Then we take all the contents of our temp dir and copy them to cwd: */
  await fs.copy(currentTempDir, process.cwd());

  return [].concat(topLevelDirs, FILE_PATH_MANIFEST);
}

export async function getGitCustomDiff(touchedPaths): Promise<IDiffSummary[]> {
  const { stdout: gitRootDir } = await execa('git', ['rev-parse', '--show-toplevel']);
  /* Stage all changes to tracked files. */
  /* Stage the "intent" to add for all untracked files. */
  await execa('git', ['add', '-f', '--ignore-removal', '--intent-to-add', '--', ...touchedPaths]);
  /* Grab the lines changed per file, as well as the kind of change (D, M, A) */
  const [{ stdout: numstatRaw }, { stdout: nameStatRaw }] = await Promise.all([
    execa('git', ['diff', '--numstat', '--no-renames', '--', './']),
    execa('git', ['diff', '--name-status', '--no-renames', '--', './']),
  ]);

  /* Transform the raw stdout to renderable data. */
  const nameStat = nameStatRaw.split('\n').map(line => line[0]);
  const diffSummaries: IDiffSummary[] = numstatRaw
    .split('\n')
    .map(line => line.split('\t'))
    .map(([additions, deletions, filePath], i) => {
      const filePathFromCwd = filePath
        .replace(path.relative(gitRootDir, process.cwd()), '')
        .replace(/^\//, '');

      return {
        status: nameStat[i] || 'M',
        additions: parseInt(additions, 10),
        deletions: parseInt(deletions, 10),
        filePath: filePathFromCwd,
        fullFilePath: filePath,
      };
    });

  /* Undo the staging done above, to ensure an expected git status after this tool has been run. */
  await execa('git', ['reset', 'HEAD', './']);

  return diffSummaries;
}
