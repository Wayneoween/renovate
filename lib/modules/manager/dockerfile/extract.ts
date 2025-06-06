import is from '@sindresorhus/is';
import { logger } from '../../../logger';
import { newlineRegex, regEx } from '../../../util/regex';
import { DockerDatasource } from '../../datasource/docker';
import * as debianVersioning from '../../versioning/debian';
import * as ubuntuVersioning from '../../versioning/ubuntu';
import type {
  ExtractConfig,
  PackageDependency,
  PackageFileContent,
} from '../types';

const variableMarker = '$';

export function extractVariables(image: string): Record<string, string> {
  const variables: Record<string, string> = {};
  const variableRegex = regEx(
    /(?<fullvariable>\\?\$(?<simplearg>\w+)|\\?\${(?<complexarg>\w+)(?::.+?)?}+)/gi,
  );

  let match: RegExpExecArray | null;
  do {
    match = variableRegex.exec(image);
    if (match?.groups?.fullvariable) {
      variables[match.groups.fullvariable] =
        match.groups?.simplearg || match.groups?.complexarg;
    }
  } while (match);

  return variables;
}

function getAutoReplaceTemplate(dep: PackageDependency): string | undefined {
  let template = dep.replaceString;

  if (dep.currentValue) {
    let placeholder = '{{#if newValue}}{{newValue}}{{/if}}';
    if (!dep.currentDigest) {
      placeholder += '{{#if newDigest}}@{{newDigest}}{{/if}}';
    }
    template = template?.replace(dep.currentValue, placeholder);
  }

  if (dep.currentDigest) {
    template = template?.replace(
      dep.currentDigest,
      '{{#if newDigest}}{{newDigest}}{{/if}}',
    );
  }

  return template;
}

function processDepForAutoReplace(
  dep: PackageDependency,
  lineNumberRanges: number[][],
  lines: string[],
  linefeed: string,
): void {
  const lineNumberRangesToReplace: number[][] = [];
  for (const lineNumberRange of lineNumberRanges) {
    for (const lineNumber of lineNumberRange) {
      if (
        (is.string(dep.currentValue) &&
          lines[lineNumber].includes(dep.currentValue)) ||
        (is.string(dep.currentDigest) &&
          lines[lineNumber].includes(dep.currentDigest))
      ) {
        lineNumberRangesToReplace.push(lineNumberRange);
      }
    }
  }

  lineNumberRangesToReplace.sort((a, b) => {
    return a[0] - b[0];
  });

  const minLine = lineNumberRangesToReplace[0]?.[0];
  const maxLine =
    lineNumberRangesToReplace[lineNumberRangesToReplace.length - 1]?.[1];
  if (
    lineNumberRanges.length === 1 ||
    minLine === undefined ||
    maxLine === undefined
  ) {
    return;
  }

  const unfoldedLineNumbers = Array.from(
    { length: maxLine - minLine + 1 },
    (_v, k) => k + minLine,
  );

  dep.replaceString = unfoldedLineNumbers
    .map((lineNumber) => lines[lineNumber])
    .join(linefeed);

  if (!dep.currentDigest) {
    dep.replaceString += linefeed;
  }

  dep.autoReplaceStringTemplate = getAutoReplaceTemplate(dep);
}

export function splitImageParts(currentFrom: string): PackageDependency {
  let isVariable = false;
  let cleanedCurrentFrom = currentFrom;

  // Check if we have a variable in format of "${VARIABLE:-<image>:<defaultVal>@<digest>}"
  // If so, remove everything except the image, defaultVal and digest.
  if (cleanedCurrentFrom?.includes(variableMarker)) {
    const defaultValueRegex = regEx(/^\${.+?:-"?(?<value>.*?)"?}$/);
    const defaultValueMatch =
      defaultValueRegex.exec(cleanedCurrentFrom)?.groups;
    if (defaultValueMatch?.value) {
      isVariable = true;
      cleanedCurrentFrom = defaultValueMatch.value;
    }

    if (cleanedCurrentFrom?.includes(variableMarker)) {
      // If cleanedCurrentFrom contains a variable, after cleaning, e.g. "$REGISTRY/alpine", we do not support this.
      return {
        skipReason: 'contains-variable',
      };
    }
  }

  const [currentDepTag, currentDigest] = cleanedCurrentFrom.split('@');
  const depTagSplit = currentDepTag.split(':');
  let depName: string;
  let currentValue: string | undefined;
  if (
    depTagSplit.length === 1 ||
    depTagSplit[depTagSplit.length - 1].includes('/')
  ) {
    depName = currentDepTag;
  } else {
    currentValue = depTagSplit.pop();
    depName = depTagSplit.join(':');
  }

  const dep: PackageDependency = {
    depName,
    packageName: depName,
    currentValue,
    currentDigest,
  };

  if (isVariable) {
    dep.replaceString = cleanedCurrentFrom;

    if (!dep.currentValue) {
      delete dep.currentValue;
    }

    if (!dep.currentDigest) {
      delete dep.currentDigest;
    }
  }

  return dep;
}

const quayRegex = regEx(/^quay\.io(?::[1-9][0-9]{0,4})?/i);

export function getDep(
  currentFrom: string | null | undefined,
  specifyReplaceString = true,
  registryAliases?: Record<string, string>,
): PackageDependency {
  if (
    !is.string(currentFrom) ||
    !is.nonEmptyStringAndNotWhitespace(currentFrom)
  ) {
    return {
      skipReason: 'invalid-value',
    };
  }

  // Resolve registry aliases first so that we don't need special casing later on:
  for (const [name, value] of Object.entries(registryAliases ?? {})) {
    // Check for two possible formats:
    // 1. Variable followed by slash: "${VAR}/image"
    // 2. Variable including a slash: "${VAR}image"
    if (currentFrom.startsWith(`${name}/`) || currentFrom.startsWith(name)) {
      const depNameStartIndex = currentFrom.startsWith(`${name}/`) ? name.length + 1 : name.length;
      const depName = currentFrom.substring(depNameStartIndex);
      const valueWithSlash = value.endsWith('/') ? value : `${value}/`;
      const dep = {
        ...getDep(`${valueWithSlash}${depName}`, false),
        replaceString: currentFrom,
      };
      // retain depName, not sure if condition is necessary
      if (dep.depName?.startsWith(valueWithSlash)) {
        dep.packageName = dep.depName;
        // Keep original name and path structure in the depName
        if (currentFrom.includes(':')) {
          dep.depName = currentFrom.substring(0, currentFrom.indexOf(':'));
        }
      }
      if (specifyReplaceString) {
        dep.autoReplaceStringTemplate = getAutoReplaceTemplate(dep);
      }
      return dep;
    }
  }

  const dep = splitImageParts(currentFrom);
  if (specifyReplaceString) {
    dep.replaceString ??= currentFrom;
    dep.autoReplaceStringTemplate =
      '{{depName}}{{#if newValue}}:{{newValue}}{{/if}}{{#if newDigest}}@{{newDigest}}{{/if}}';
  }
  dep.datasource = DockerDatasource.id;

  // Pretty up special prefixes
  if (dep.depName) {
    const specialPrefixes = ['amd64', 'arm64', 'library'];
    for (const prefix of specialPrefixes) {
      if (dep.depName.startsWith(`${prefix}/`)) {
        dep.depName = dep.depName.replace(`${prefix}/`, '');
        if (specifyReplaceString) {
          dep.autoReplaceStringTemplate =
            '{{packageName}}{{#if newValue}}:{{newValue}}{{/if}}{{#if newDigest}}@{{newDigest}}{{/if}}';
        }
      }
    }
  }

  if (dep.depName === 'ubuntu' || dep.depName?.endsWith('/ubuntu')) {
    dep.versioning = ubuntuVersioning.id;
  }

  if (
    (dep.depName === 'debian' || dep.depName?.endsWith('/debian')) &&
    debianVersioning.api.isVersion(dep.currentValue)
  ) {
    dep.versioning = debianVersioning.id;
  }

  // Don't display quay.io ports
  if (dep.depName && quayRegex.test(dep.depName)) {
    const depName = dep.depName.replace(quayRegex, 'quay.io');
    if (depName !== dep.depName) {
      dep.depName = depName;
      dep.autoReplaceStringTemplate =
        '{{packageName}}{{#if newValue}}:{{newValue}}{{/if}}{{#if newDigest}}@{{newDigest}}{{/if}}';
    }
  }

  return dep;
}

export function extractPackageFile(
  content: string,
  _packageFile: string,
  config: ExtractConfig,
): PackageFileContent | null {
  const sanitizedContent = content.replace(regEx(/^\uFEFF/), ''); // remove bom marker
  const deps: PackageDependency[] = [];
  const stageNames: string[] = [];
  const args: Record<string, string> = {};
  const argsLines: Record<string, number[]> = {};

  let escapeChar = '\\\\';
  let lookForEscapeChar = true;
  let lookForSyntaxDirective = true;

  const lineFeed = sanitizedContent.includes('\r\n') ? '\r\n' : '\n';
  const lines = sanitizedContent.split(newlineRegex);
  for (let lineNumber = 0; lineNumber < lines.length; ) {
    const lineNumberInstrStart = lineNumber;
    let instruction = lines[lineNumber];

    if (lookForEscapeChar) {
      const directivesMatch = regEx(
        /^[ \t]*#[ \t]*(?<directive>syntax|escape)[ \t]*=[ \t]*(?<escapeChar>\S)/i,
      ).exec(instruction);
      if (!directivesMatch) {
        lookForEscapeChar = false;
      } else if (directivesMatch.groups?.directive.toLowerCase() === 'escape') {
        if (directivesMatch.groups?.escapeChar === '`') {
          escapeChar = '`';
        }
        lookForEscapeChar = false;
      }
    }

    if (lookForSyntaxDirective) {
      const syntaxRegex = regEx(
        '^#[ \\t]*syntax[ \\t]*=[ \\t]*(?<image>\\S+)',
        'im',
      );
      const syntaxMatch = instruction.match(syntaxRegex);
      if (syntaxMatch?.groups?.image) {
        const syntaxImage = syntaxMatch.groups.image;
        const lineNumberRanges: number[][] = [
          [lineNumberInstrStart, lineNumber],
        ];
        const dep = getDep(syntaxImage, true, config.registryAliases);
        dep.depType = 'syntax';
        processDepForAutoReplace(dep, lineNumberRanges, lines, lineFeed);
        logger.trace(
          {
            depName: dep.depName,
            currentValue: dep.currentValue,
            currentDigest: dep.currentDigest,
          },
          'Dockerfile # syntax',
        );
        deps.push(dep);
      }
      lookForSyntaxDirective = false;
    }

    const lineContinuationRegex = regEx(escapeChar + '[ \\t]*$|^[ \\t]*#', 'm');
    let lineLookahead = instruction;
    while (
      !lookForEscapeChar &&
      !instruction.trimStart().startsWith('#') &&
      lineContinuationRegex.test(lineLookahead)
    ) {
      lineLookahead = lines[++lineNumber] || '';
      instruction += '\n' + lineLookahead;
    }

    const argRegex = regEx(
      '^[ \\t]*ARG(?:' +
        escapeChar +
        '[ \\t]*\\r?\\n| |\\t|#.*?\\r?\\n)+(?<name>\\w+)[ =](?<value>\\S*)',
      'im',
    );
    const argMatch = argRegex.exec(instruction);
    if (argMatch?.groups?.name) {
      argsLines[argMatch.groups.name] = [lineNumberInstrStart, lineNumber];
      let argMatchValue = argMatch.groups?.value;

      if (argMatchValue.startsWith('"') && argMatchValue.endsWith('"')) {
        argMatchValue = argMatchValue.slice(1, -1);
      }

      args[argMatch.groups.name] = argMatchValue || '';
    }

    const fromRegex = new RegExp(
      '^[ \\t]*FROM(?:' +
        escapeChar +
        '[ \\t]*\\r?\\n| |\\t|#.*?\\r?\\n|--platform=\\S+)+(?<image>\\S+)(?:(?:' +
        escapeChar +
        '[ \\t]*\\r?\\n| |\\t|#.*?\\r?\\n)+as[ \\t]+(?<name>\\S+))?',
      'im',
    ); // TODO #12875 complex for re2 has too many not supported groups
    const fromMatch = instruction.match(fromRegex);
    if (fromMatch?.groups?.image) {
      let fromImage = fromMatch.groups.image;
      const lineNumberRanges: number[][] = [[lineNumberInstrStart, lineNumber]];

      if (fromImage.includes(variableMarker)) {
        const variables = extractVariables(fromImage);
        for (const [fullVariable, argName] of Object.entries(variables)) {
          const resolvedArgValue = args[argName];
          if (resolvedArgValue || resolvedArgValue === '') {
            fromImage = fromImage.replace(fullVariable, resolvedArgValue);
            lineNumberRanges.push(argsLines[argName]);
          }
        }
      }

      if (fromMatch.groups?.name) {
        logger.debug(
          `Found a multistage build stage name: ${fromMatch.groups.name}`,
        );
        stageNames.push(fromMatch.groups.name);
      }
      if (fromImage === 'scratch') {
        logger.debug('Skipping scratch');
      } else if (fromImage && stageNames.includes(fromImage)) {
        logger.debug(`Skipping alias FROM image:${fromImage}`);
      } else {
        const dep = getDep(fromImage, true, config.registryAliases);
        processDepForAutoReplace(dep, lineNumberRanges, lines, lineFeed);
        logger.trace(
          {
            depName: dep.depName,
            currentValue: dep.currentValue,
            currentDigest: dep.currentDigest,
          },
          'Dockerfile FROM',
        );
        deps.push(dep);
      }
    }

    const copyFromRegex = new RegExp(
      '^[ \\t]*COPY(?:' +
        escapeChar +
        '[ \\t]*\\r?\\n| |\\t|#.*?\\r?\\n|--[a-z]+(?:=[a-zA-Z0-9_.:-]+?)?)+--from=(?<image>\\S+)',
      'im',
    ); // TODO #12875 complex for re2 has too many not supported groups
    const copyFromMatch = instruction.match(copyFromRegex);
    if (copyFromMatch?.groups?.image) {
      if (stageNames.includes(copyFromMatch.groups.image)) {
        logger.debug(
          { image: copyFromMatch.groups.image },
          'Skipping alias COPY --from',
        );
      } else if (Number.isNaN(Number(copyFromMatch.groups.image))) {
        const dep = getDep(
          copyFromMatch.groups.image,
          true,
          config.registryAliases,
        );
        const lineNumberRanges: number[][] = [
          [lineNumberInstrStart, lineNumber],
        ];
        processDepForAutoReplace(dep, lineNumberRanges, lines, lineFeed);
        logger.debug(
          {
            depName: dep.depName,
            currentValue: dep.currentValue,
            currentDigest: dep.currentDigest,
          },
          'Dockerfile COPY --from',
        );
        deps.push(dep);
      } else {
        logger.debug(
          { image: copyFromMatch.groups.image },
          'Skipping index reference COPY --from',
        );
      }
    }

    const runMountFromRegex = regEx(
      '^[ \\t]*RUN(?:' +
        escapeChar +
        '[ \\t]*\\r?\\n| |\\t|#.*?\\r?\\n|--[a-z]+(?:=[a-zA-Z0-9_.:-]+?)?)+--mount=(?:\\S*=\\S*,)*from=(?<image>[^, ]+)',
      'im',
    );
    const runMountFromMatch = instruction.match(runMountFromRegex);
    if (runMountFromMatch?.groups?.image) {
      if (stageNames.includes(runMountFromMatch.groups.image)) {
        logger.debug(
          { image: runMountFromMatch.groups.image },
          'Skipping alias RUN --mount=from',
        );
      } else {
        const dep = getDep(
          runMountFromMatch.groups.image,
          true,
          config.registryAliases,
        );
        const lineNumberRanges: number[][] = [
          [lineNumberInstrStart, lineNumber],
        ];
        processDepForAutoReplace(dep, lineNumberRanges, lines, lineFeed);
        logger.debug(
          {
            depName: dep.depName,
            currentValue: dep.currentValue,
            currentDigest: dep.currentDigest,
          },
          'Dockerfile RUN --mount=from',
        );
        deps.push(dep);
      }
    }

    lineNumber += 1;
  }

  if (!deps.length) {
    return null;
  }
  for (const d of deps) {
    d.depType ??= 'stage';
  }
  deps[deps.length - 1].depType = 'final';
  return { deps };
}
