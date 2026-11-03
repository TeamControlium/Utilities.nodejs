import { Logger } from "./logger/logger.js";

/** Minimum Node.js major version this package supports. */
const MIN_SUPPORTED_NODE_MAJOR = 22;

/**
 * Rejects import of this package outright on an unsupported Node.js runtime, rather than
 * letting a consumer discover incompatibility later as a confusing failure deep inside some
 * unrelated method. Declaring `engines` in `package.json` alone only produces an install-time
 * *warning* by default (and no warning at all if a lockfile/CI bypasses install), so it cannot
 * be relied on to actually stop an unsupported runtime — this check runs unconditionally the
 * moment the package is imported, regardless of how it was installed.
 */
function assertSupportedNodeVersion(): void {
  // Pull out just the major-version number, e.g. "22" from "22.4.0".
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (Number.isNaN(major)) {
    // process.versions.node is a Node.js guarantee, not external input — if it's ever
    // unparseable there's nothing meaningful to enforce here, so fail open rather than block.
    return;
  }
  // Below the supported floor — block the import with a clear, actionable error rather than
  // letting the consumer hit a confusing failure later, deep inside some unrelated method.
  if (major < MIN_SUPPORTED_NODE_MAJOR) {
    throw new Error(
      `@controlium/utils requires Node.js >= ${MIN_SUPPORTED_NODE_MAJOR}. Running Node.js ${process.versions.node}. Please upgrade Node.js to use this package.`
    );
  }
}

assertSupportedNodeVersion();

export { Logger, Logger as Log };
export const LogLevels = Logger.Levels;

export type {
  LogLevel,
  VideoOptions,
  WriteLineOptions,
  LogOutputCallbackSignature,
} from "./logger/types.js";

export { APIUtils } from "./apiUtils/APIUtils.js";
export { JsonUtils } from "./jsonUtils/jsonUtils.js";
export { XmlUtils } from "./xmlUtils/xmlUtils.js";
export type { XmlDocument } from "./xmlUtils/xmlUtils.js";
export { YamlUtils } from "./yamlUtils/yamlUtils.js";
export { StringUtils } from "./stringUtils/stringUtils.js";
export { Utils, ExistingFileWriteActions } from "./utils/utils.js";
export type { AssertTypeMap, AssertShapeMap, ActionAndParams, SettingResult, SettingsContext } from "./utils/utils.js";

export { Mock } from "./mock/mock.js";

export { Settings } from "./settings/settings.js";

export { Detokeniser } from "./detokeniser/detokeniser.js";

export { ValueExpression } from "./valueExpression/valueExpression.js";
