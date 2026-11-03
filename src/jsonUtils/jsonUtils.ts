import json5 from "json5";
import * as JSONPath from "jsonpath-plus";
import JSONPointer from "jsonpointer";

import { Log, LogLevels, StringUtils, Utils } from "../index.js";

/**
 * JSON utility methods for querying, manipulating, parsing and validating JSON objects.
 * All methods are static — no instantiation required.
 */
export class JsonUtils {
  /**
   * Sentinel value recognised by {@link updateJSONObject} and {@link resolveSentinels}:
   * when a property's value is exactly this string, the property is removed entirely
   * rather than set to the literal text. The only way to express "delete this key" from
   * a plain data value (a DataTable cell, a JSON literal, a file's contents) — there is
   * no other textual convention for "omit this key" as distinct from "never mention this
   * key at all".
   */
  public static readonly SENTINEL_UNDEFINED = "_undefined";

  /**
   * Sentinel value recognised by {@link resolveSentinels}: when a property's value is
   * exactly this string, the property is set to a real `null` rather than the literal
   * text `"_null"`. Exists because a DataTable cell is always a string — there is no way
   * to type an actual `null` into one — whereas a JSON literal or file can already express
   * real `null` directly and has no need of this sentinel.
   */
  public static readonly SENTINEL_NULL = "_null";

  /**
   * Returns the JSONPath path to the parent of the node addressed by the given path.
   *
   * @param pathToChild - A valid JSONPath path to a JSON node.
   * @returns The JSONPath path to the parent of the given node.
   * @throws {Error} If the node has no parent (i.e. it is a top-level node).
   *
   * @example
   * JsonUtils.getParentPath("$.a.b.c"); // returns "$.a.b"
   */
  static getParentPath(pathToChild: string): string {

    ////////////////////////////////////////////////////
    //
    // Walks pathToChild's JSONPath segments, drops the last one (the child itself), and
    // rebuilds the remaining segments back into a JSONPath string — the parent's own path.

    // pathToChild must actually be a string — fail fast and clearly if not.
    Utils.assertType(pathToChild, "string", "JsonUtils.getParentPath", "pathToChild");
    // Break the path into its individual segments. A leading '.' is prepended unless already
    // present, so jsonpath-plus treats the path as rooted rather than a bare property name.
    const pathArray = JSONPath.JSONPath.toPathArray((pathToChild.startsWith(".") ? "" : ".") + pathToChild);
    // Fewer than 2 segments means there's no parent to return — the path is already top-level.
    if (pathArray.length < 2) {
      const errText = `Unable to get Parent as child [${pathToChild}] has no parent (it is top level)!`;
      Log.logErrorAndThrow(errText);
    }
    // Drop the last segment (the child itself) and rebuild what's left into a path string.
    pathArray.pop();
    return JSONPath.JSONPath.toPathString(pathArray);
  }

  /**
   * Returns a deep copy of the given object with the property identified by the
   * given JSONPath renamed. The original object is not mutated.
   *
   * The JSONPath must match exactly one property — zero or multiple matches will throw.
   *
   * @param jsonObject - The source object containing the property to rename.
   * @param pathToPropertyToRename - A valid JSONPath identifying the property to rename.
   * @param newName - The new name for the property.
   * @returns A new deep-copied object with the property renamed.
   * @throws {Error} If the JSONPath matches zero or more than one property.
   *
   * @example
   * const result = JsonUtils.withRenamedProperty({ a: { b: 1 } }, "$.a.b", "c");
   * // result => { a: { c: 1 } }
   */
  static withRenamedProperty(jsonObject: object, pathToPropertyToRename: string, newName: string): object {

    ////////////////////////////////////////////////////
    //
    // Renames a property by adding a new property with the new name/old value, then
    // deleting the old-named property — there's no native "rename" primitive on a plain
    // object addressed by JSONPath, so this composes two already-existing update operations
    // instead. Works on a deep copy throughout; the caller's own jsonObject is never mutated.

    // Validate all three arguments up front — fail fast and clearly before touching anything.
    Utils.assertShape(jsonObject, "nonNullObject", "JsonUtils.withRenamedProperty", "jsonObject");
    Utils.assertType(pathToPropertyToRename, "string", "JsonUtils.withRenamedProperty", "pathToPropertyToRename");
    Utils.assertType(newName, "string", "JsonUtils.withRenamedProperty", "newName");
    const normalizedNewName = newName.trim();
    // Work out the parent path — the new property needs to be added as a sibling of the old
    // one, not at the root.
    const parentPath = this.getParentPath(pathToPropertyToRename);
    // Resolve the property actually being renamed — needed for both its current value (to
    // copy across) and to validate the path matches exactly one property.
    const objectBeingRenamed = this.getPropertiesMatchingPath(jsonObject, pathToPropertyToRename);
    if (objectBeingRenamed.length === 0) {
      // Path matched nothing — there's no property to rename at all.
      const errText = `renameJsonObjectProperty: cannot rename - JSON Path [${pathToPropertyToRename}] matches nothing`;
      Log.logErrorAndThrow(errText);
    } else if (objectBeingRenamed.length > 1) {
      // Path matched more than one property — ambiguous, so refuse rather than guess which one.
      const errText = `renameJsonObjectProperty: cannot rename - JSON Path [${pathToPropertyToRename}] matches ${objectBeingRenamed.length} fields/objects!! Expected exactly 1 match`;
      Log.logErrorAndThrow(errText);
    } else {
      // Exactly one match — resolve the parent object's own JSON Pointer, then build the
      // pointer-style path the new, renamed property will live at (as a sibling of the old
      // one): the parent's path with the new name appended, using bracket notation as-is if
      // the caller already supplied it (e.g. "['odd key']"), otherwise joined with a dot.
      const objectBeingRenamedParent = this.getPropertiesMatchingPath(jsonObject, parentPath);
      let pathToNewObject = StringUtils.replaceAll(objectBeingRenamedParent[0].pointer, "/", ".") as string;
      pathToNewObject = StringUtils.isBlank(pathToNewObject) ? normalizedNewName : ((normalizedNewName.startsWith("['") && normalizedNewName.endsWith("']")) ? pathToNewObject.substring(1) + normalizedNewName : pathToNewObject.substring(1) + "." + normalizedNewName);
      // Deep-copy the source object — everything from here on operates on the copy only.
      let updatedObject = JSON.parse(JSON.stringify(jsonObject));
      // We rename the property by adding the property using the new name...
      updatedObject = this.updateJSONObject(updatedObject, pathToNewObject, objectBeingRenamed[0].value as string | number | boolean | object | null);
      // ... then deleting the property with the old name
      updatedObject = this.updateJSONObject(updatedObject, pathToPropertyToRename, this.SENTINEL_UNDEFINED);
      return updatedObject;
    }
  }

  /**
   * Shallow-merges the given object into the property identified by the given JSONPath
   * within the source object. Properties in `objectToMerge` overwrite same-named
   * properties in the target. The JSONPath must match exactly one property.
   *
   * Use `"$"` as the path to merge directly into the root object.
   *
   * @param jsonObject - The source object containing the property to merge into.
   * @param pathToPropertyToMergeInto - A valid JSONPath identifying the target property.
   * @param objectToMerge - The object whose properties will be merged into the target.
   * @returns The updated source object with the merge applied.
   * @throws {Error} If the JSONPath matches zero or more than one property.
   *
   * @example
   * const result = JsonUtils.mergeObjectIntoProperty({ a: { x: 1 } }, "$.a", { y: 2 });
   * // result => { a: { x: 1, y: 2 } }
   */
  static mergeObjectIntoProperty(jsonObject: object, pathToPropertyToMergeInto: string, objectToMerge: object): object {

    ////////////////////////////////////////////////////
    //
    // Resolves the target property by path, shallow-merges objectToMerge's own properties
    // over it (objectToMerge wins on any shared key), then writes the merged result back —
    // either by building a brand new root object (the "$" root case, where there's no
    // parent path to update through) or via the normal updateJSONObject path otherwise.

    // Validate all three arguments up front — fail fast and clearly before touching anything.
    Utils.assertShape(jsonObject, "nonNullObject", "JsonUtils.mergeObjectIntoProperty", "jsonObject");
    Utils.assertType(pathToPropertyToMergeInto, "string", "JsonUtils.mergeObjectIntoProperty", "pathToPropertyToMergeInto");
    Utils.assertShape(objectToMerge, "nonNullObject", "JsonUtils.mergeObjectIntoProperty", "objectToMerge");
    // Resolve the target property — needed for its current value (the merge base) and to
    // validate the path matches exactly one property.
    const objectToMergeWith = this.getPropertiesMatchingPath(jsonObject, pathToPropertyToMergeInto);
    if (objectToMergeWith.length === 0) {
      // Path matched nothing — there's no target property to merge into.
      const errText = `mergeJsonObjects: cannot merge - JSON Path [${pathToPropertyToMergeInto}] matches nothing`;
      Log.logErrorAndThrow(errText);
    } else if (objectToMergeWith.length > 1) {
      // Path matched more than one property — ambiguous, so refuse rather than guess which one.
      const errText = `mergeJsonObjects: cannot merge - JSON Path [${pathToPropertyToMergeInto}] matches ${objectToMergeWith.length} fields/objects!! Expected exactly 1 match`;
      Log.logErrorAndThrow(errText);
    } else {
      // Exactly one match — shallow-merge objectToMerge's properties over the target's own.
      const targetObject = objectToMergeWith[0].value as object;
      let mergedOriginalObject = jsonObject;
      if (pathToPropertyToMergeInto === "$") {
        // Merging into the root itself — there's no parent path to route an update through,
        // so just build the merged object directly and return it as the new root.
        mergedOriginalObject = { ...targetObject, ...objectToMerge };
      } else {
        // Merging into a nested property — write the merged result back via the normal
        // path-addressed update, which also takes care of the deep copy.
        mergedOriginalObject = this.updateJSONObject(mergedOriginalObject, pathToPropertyToMergeInto, { ...targetObject, ...objectToMerge });
      }
      return mergedOriginalObject;
    }
  }

  /**
   * Reads a file from disk and parses its contents as JSON, returning the result as an object.
   * Returns an empty object `{}` if the file contents are not valid JSON.
   *
   * @param pathAndFilename - Path to the JSON file to read.
   * @param options - Optional settings:
   *   - `encoding` — File encoding to use when reading (default: `"utf-8"`).
   * @returns The parsed JSON as an object, or `{}` if the file contains invalid JSON.
   * @throws {Error} If the file cannot be read.
   */
  static getObjectFromFile(pathAndFilename: string, options?: { encoding?: BufferEncoding }): object {

    ////////////////////////////////////////////////////
    //
    // Loads the file's raw contents, checks whether they're valid JSON, then either parses
    // and returns them or — deliberately not throwing — logs an error and returns an empty
    // object instead, so a caller treating "no data yet" as a valid starting state isn't
    // forced into its own try/catch just to call this.

    // pathAndFilename must actually be a string — fail fast and clearly if not.
    Utils.assertType(pathAndFilename, "string", "JsonUtils.getObjectFromFile", "pathAndFilename");
    // Read the file's raw contents (throws if the file can't be read at all).
    const processedJson = Utils.getFileContents(pathAndFilename, { encoding: options?.encoding });
    if (this.isJson(processedJson)) {
      // Contents are valid JSON — parse and return them.
      const jsonObject = JSON.parse(processedJson);
      return jsonObject;
    } else {
      // Contents are NOT valid JSON — log it and return an empty object rather than throwing.
      Log.writeLine(LogLevels.Error, `File [${pathAndFilename}] does not contain valid JSON.  Returning empty object`);
      return {};
    }
  }

  /**
   * Parses a JSON (or optionally JSON5) string into an object.
   * If `item` is `null`, an empty object `{}` is returned.
   *
   * @param item - The JSON string to parse, or `null` (returns `{}`).
   * @param useJson5 - When `true`, parses using JSON5 rules, allowing comments,
   *   trailing commas, unquoted keys, etc. Defaults to `false` (strict JSON).
   * @returns The parsed object.
   * @throws {Error} If `item` is not a string or null, or if parsing fails.
   *
   * @example
   * JsonUtils.parse('{"a":1}');           // => { a: 1 }
   * JsonUtils.parse(null);                // => {}
   * JsonUtils.parse("{a:1}", true);       // => { a: 1 }  (JSON5)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static parse(item: string | null, useJson5 = false): any {

    ////////////////////////////////////////////////////
    //
    // Normalises null to an empty-object string, rejects anything that isn't a string,
    // then parses using either strict JSON or JSON5 rules depending on useJson5 — wrapping
    // any parse failure in a clearer, item-specific error rather than letting the raw
    // JSON.parse/json5.parse error (which doesn't know what this value is "for") propagate.

    // null is treated as "nothing to parse" — substitute the literal empty-object text.
    if (Utils.isNull(item)) {
      item = "{}";
    }
    // Anything other than a string (undefined, a number, etc.) at this point is a caller
    // error — fail fast and clearly.
    if (typeof item !== "string") {
      const errMsg = `Cannot parse item [${typeof item}] as not null or string!`;
      Log.logErrorAndThrow(errMsg);
    }
    try {
      // Parse using JSON5 rules if the caller opted in, otherwise strict JSON.
      return useJson5 ? json5.parse(item) : JSON.parse(item);
    } catch (err) {
      // Parsing failed — log and throw a clearer error, including the item itself (or just
      // its length, if it's long enough that dumping it in full wouldn't be useful).
      const errTxt = `Cannot parse item [${item.length < 50 ? item : `Length ${item.length}`}]: ${Utils.errorMessage(err)}`;
      Log.logErrorAndThrow(errTxt);
    }
  }

  /**
   * Checks whether the given item is valid JSON.
   *
   * Returns `true` if:
   * - `item` is a string that parses as a JSON object (not a primitive), or
   * - `item` is an object that can be `JSON.stringify`-ed and parsed back as an object.
   *
   * Returns `false` for `undefined`, unparseable strings, or values that parse
   * to a primitive (e.g. `"true"`, `"42"`).
   *
   * @param item - The value to check.
   * @param allowJson5 - When `true`, accepts JSON5 syntax (comments, trailing commas,
   *   unquoted keys, etc.). Defaults to `false` (strict JSON only).
   * @returns `true` if the item represents a valid JSON object, `false` otherwise.
   *
   * @example
   * JsonUtils.isJson('{"a":1}');        // true
   * JsonUtils.isJson('42');             // false  (primitive)
   * JsonUtils.isJson(undefined);        // false
   * JsonUtils.isJson("{a:1}", true);    // true   (JSON5)
   */
  static isJson(item: string | object | undefined | null, allowJson5 = false): boolean {

    ////////////////////////////////////////////////////
    //
    // Normalises item to a string (stringifying it first if it's already an object), then
    // parses that string and checks the parsed result is itself an object (not a primitive)
    // — a round-trip check, since the only way to be sure a string really "is JSON" (as
    // opposed to merely a quoted primitive like '"true"' or '42') is to actually parse it.

    // undefined is never valid JSON — short-circuit before the try/catch below.
    if (Utils.isUndefined(item)) {
      return false;
    }
    try {
      // If item's already an object, stringify it first — the rest of this function only
      // deals with the string form either way.
      item = typeof item === "object" ? JSON.stringify(item) : item;
      // Parse using JSON5 or strict JSON rules, per allowJson5. Throws on malformed input,
      // caught below.
      item = allowJson5 ? json5.parse(item as string) : JSON.parse(item as string);
      // Only a parsed object (not a primitive like a number, string, or boolean) counts as
      // "is JSON" here — a bare '42' or '"hello"' parses fine but isn't what this is asking.
      if (typeof item === "object" && item !== null) {
        return true;
      }
    } catch {
      // Parsing failed — not valid JSON (or JSON5, if that was requested).
      return false;
    }
    // Parsed successfully but to a primitive, not an object — still not "is JSON" here.
    return false;
  }

  /**
   * Asserts `value` is a plain object — not `null`, not an array, not a primitive — and
   * returns it narrowed to `Record<string, unknown>`. Shared validation for every caller
   * that resolves some value (parsed JSON, a `ValueExpression`/`Detokeniser` result, a
   * test-data file's contents, etc.) and needs to guarantee it's actually an object before
   * treating it as one — e.g. a set of HTTP headers or body-path modifications can never
   * meaningfully be an array or a bare string/number.
   *
   * @param value - The value to check.
   * @param context - Short description of what's being validated, prefixed onto the error
   *   message so a caller can tell exactly which value failed (e.g. `"request headers"`).
   * @returns `value`, narrowed to `Record<string, unknown>`.
   * @throws {Error} If `value` is `null`, an array, or not a `typeof "object"` at all.
   *
   * @example
   * JsonUtils.assertPlainObject({ a: 1 }, "headers");        // => { a: 1 }
   * JsonUtils.assertPlainObject([1, 2], "headers");          // throws
   * JsonUtils.assertPlainObject(null, "headers");            // throws
   */
  static assertPlainObject(value: unknown, context: string): Record<string, unknown> {
    // null, any non-object (string/number/boolean/undefined), and arrays are all rejected —
    // only a genuine plain object passes.
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      const errText = `${context}: must be a JSON object. Value: ${Utils.safeStringify(value)}`;
      Log.logErrorAndThrow(errText);
    }
    return value as Record<string, unknown>;
  }

  /**
   * Parses `text` as JSON (or JSON5) and asserts the result is a plain object, via
   * {@link parse} + {@link assertPlainObject} — the single combined operation almost every
   * "parse this literal JSON text" caller actually wants, with one clear, context-specific
   * error either way (a parse failure, or a parse success that wasn't an object).
   *
   * @param text - The JSON/JSON5 text to parse.
   * @param context - Short description of what's being parsed, prefixed onto either error
   *   message so a caller can tell exactly which value failed (e.g. `"request headers"`).
   * @param useJson5 - When `true`, parses using JSON5 rules (comments, trailing commas,
   *   unquoted keys, etc.). Defaults to `false` (strict JSON).
   * @returns The parsed object.
   * @throws {Error} If `text` doesn't parse at all, or parses to something other than a
   *   plain object (an array, a primitive, `null`).
   *
   * @example
   * JsonUtils.parseObjectLiteral('{"a":1}', "request headers");         // => { a: 1 }
   * JsonUtils.parseObjectLiteral("{a:1}", "request headers", true);     // => { a: 1 } (JSON5)
   * JsonUtils.parseObjectLiteral("[1,2]", "request headers");           // throws
   */
  static parseObjectLiteral(text: string, context: string, useJson5 = false): Record<string, unknown> {
    let parsed: unknown;
    try {
      // Parse first — a parse failure gets its own, distinctly-worded error from the
      // "parsed fine but wasn't an object" case below, so a reader can immediately tell
      // which of the two actually went wrong.
      parsed = this.parse(text, useJson5);
    } catch (err) {
      const errText = `${context}: not valid JSON${useJson5 ? "5" : ""}: ${Utils.errorMessage(err)}. Value: ${text}`;
      Log.logErrorAndThrow(errText);
    }
    return this.assertPlainObject(parsed, context);
  }

  /**
   * Returns all properties within a JSON object that match the given JSONPath expression.
   * Each result includes the matched value, its JSON Pointer path, and its parent object.
   *
   * @param jsonObject - The object (or JSON string) to query.
   * @param pathToJSONProperties - A valid JSONPath expression identifying the properties to retrieve.
   * @returns An array of matches, each with `value`, `pointer` (JSON Pointer string), and `parent`.
   *   Returns an empty array if no properties match.
   * @throws {Error} If `jsonObject` is not a valid JSON object, or if the JSONPath query fails.
   *
   * @see https://jsonpath-plus.github.io/JSONPath/docs/ts/
   *
   * @example
   * JsonUtils.getPropertiesMatchingPath({ a: { b: 1 } }, "$.a.b");
   * // => [{ value: 1, pointer: "/a/b", parent: { b: 1 } }]
   */
  static getPropertiesMatchingPath(
    jsonObject: object | string,
    pathToJSONProperties: string
  ): Array<{ value: unknown; pointer: string; parent: object }> {

    ////////////////////////////////////////////////////
    //
    // Validates jsonObject is actually JSON, normalises it from a string to a real object
    // if needed, runs the JSONPath query against it (asking for full match detail — value,
    // pointer, and parent — not just the matched values), logs what was found, and returns
    // it. Any failure anywhere in that sequence is caught, logged, and re-thrown with
    // path-specific context rather than left as a bare JSONPath-library error.

    // pathToJSONProperties must actually be a string — fail fast and clearly if not.
    Utils.assertType(pathToJSONProperties, "string", "JsonUtils.getPropertiesMatchingPath", "pathToJSONProperties");
    try {
      // jsonObject must actually be valid JSON (object or JSON string) — refuse otherwise.
      if (!this.isJson(jsonObject)) {
        throw new Error("Passed object is not a valid Json Object");
      }

      // If jsonObject was given as a JSON string, parse it into a real object — the JSONPath
      // query below needs an actual object/array to walk, not text.
      if (typeof jsonObject === "string") {
        jsonObject = JSON.parse(jsonObject);
      }

      // Run the JSONPath query, asking for full match detail (value + pointer + parent) for
      // each match rather than just the bare matched values.
      const jsonPropertys = JSONPath.JSONPath({
        path: pathToJSONProperties,
        json: jsonObject,
        resultType: "all",
      });
      // Log the full object being queried (at a very low, framework-only verbosity) and the
      // match count (at normal test-debug verbosity) before returning.
      Log.writeLine(LogLevels.FrameworkDebug, `JSON:\n${JSON.stringify(jsonObject, null, 2)}`, { maxLines: 512 });
      Log.writeLine(LogLevels.TestDebug, `For path [${pathToJSONProperties}], got ${jsonPropertys.length} matches`);

      return jsonPropertys;
    } catch (err) {
      // Something went wrong (invalid object, malformed JSONPath, etc.) — log it and
      // re-throw with path-specific context rather than a bare library error.
      Log.writeLine(LogLevels.Error, `Error getting Json properties with path [${pathToJSONProperties}] from object:\n${err}`);
      throw new Error(`Error getting Json properties with path [${pathToJSONProperties}] from object:\n${err}`);
    }
  }

  /**
   * Sets, adds, or deletes a property within a JSON object identified by a JSONPath expression.
   * Operates on a deep copy of `currentObject` — the original is not mutated.
   *
   * - If the property **exists**, its value is updated.
   * - If the property **does not exist**, it is added with the given value.
   * - To **delete** a property, pass the string `"_undefined"` as the value.
   *   Deleting a property that does not exist is a no-op — "ensure it is not there", not an
   *   error — the result is the same either way: the property is absent.
   *
   * The JSONPath must match zero or one property — multiple matches will throw. This applies
   * regardless of whether the operation is a set, an add, or a delete.
   *
   * When `Log.loggingLevel` is below `LogLevels.TestInformation`, a detailed error
   * including the full object and value is written to the log before throwing.
   *
   * @param currentObject - The source object to update (not mutated).
   * @param pathString - A valid JSONPath expression identifying the property to set/add/delete.
   * @param value - The value to set. Pass the string `"_undefined"` to delete the property.
   * @returns A new deep-copied object with the change applied.
   * @throws {Error} If `currentObject` is not a valid JSON object, if the JSONPath matches
   *   more than one property, or if the value could not be verified after being set.
   *
   * @example
   * JsonUtils.updateJSONObject({ a: 1 }, "$.a", 2);            // => { a: 2 }
   * JsonUtils.updateJSONObject({ a: 1 }, "$.b", "hello");      // => { a: 1, b: "hello" }
   * JsonUtils.updateJSONObject({ a: 1 }, "$.a", "_undefined"); // => {}
   * JsonUtils.updateJSONObject({ a: 1 }, "$.b", "_undefined"); // => { a: 1 }  ($.b was already absent)
   */
  static updateJSONObject(currentObject: object, pathString: string, value: string | object | boolean | number | null): object {

    ////////////////////////////////////////////////////
    //
    // Deep-copies currentObject, resolves pathString to zero or one matching property, then
    // either adds, updates, or deletes (SENTINEL_UNDEFINED) that property on the copy —
    // computing the target JSON Pointer differently depending on whether the path matched
    // an existing property (reuse its own pointer) or nothing at all (derive a brand new
    // pointer to add it at). Any failure anywhere is caught, optionally logged with full
    // object/value detail, and re-thrown with path-specific context.

    // pathString must actually be a string — fail fast and clearly if not.
    Utils.assertType(pathString, "string", "JsonUtils.updateJSONObject", "pathString");
    let jsonPointer: string;
    Log.writeLine(LogLevels.TestDebug, `Setting [${pathString}] of object to [${typeof value !== "object" ? value : "an object value"}]`);

    try {
      // Deep-copy currentObject via a JSON round-trip — everything from here on operates on
      // the copy only, so the caller's own object is never mutated.
      let modifiedObject: object;
      if (JsonUtils.isJson(currentObject)) {
        modifiedObject = JsonUtils.parse(JSON.stringify(currentObject));
      } else {
        const errMsg = "Object is not a JSON object.  Cannot update!";
        Log.logErrorAndThrow(errMsg);
      }
      // Resolve how many properties the path currently matches — zero (add), one (update or
      // delete), or more than one (ambiguous, refuse).
      const matchingProperties = this.getPropertiesMatchingPath(modifiedObject, pathString);
      if (matchingProperties.length > 1) {
        Log.writeLine(LogLevels.TestDebug, `[${matchingProperties.length}] matching properties found!!  Will throw error`);
        throw new Error(`JSON Path [${pathString}] matched [${matchingProperties.length}]!  Expected zero or one match.`);
      } else if (matchingProperties.length === 0) {
        // No existing property matched the path.
        if (value === this.SENTINEL_UNDEFINED) {
          // Deleting something already absent is "ensure it is not there", not an error —
          // idempotent, same as the property never having existed in the first place.
          Log.writeLine(LogLevels.TestDebug, `[${pathString}] already absent — nothing to delete`);
          return modifiedObject;
        }
        Log.writeLine(LogLevels.TestDebug, "no matching properties found - will ADD property");
        // No matches.  So work out what the Json pointer is and add it.  We prepend a period to denote path from the
        // top unless it's already rooted — a leading '$' (the JSONPath root token) or '[' (bracket notation) already
        // says "from the top" on its own; prepending another '.' in front of '$' makes jsonpath-plus treat the '$'
        // itself as a literal path segment instead of the root marker, producing a bogus extra level (e.g. "$.b"
        // would otherwise become pointer "/$/b" instead of "/b").
        const isAlreadyRooted = pathString.startsWith('[') || pathString.startsWith('$');
        const jsonPathArray = JSONPath.JSONPath.toPathArray(isAlreadyRooted ? pathString : '.' + pathString);
        jsonPointer = JSONPath.JSONPath.toPointer(jsonPathArray);
      } else {
        // Yippee exactly one property — reuse its own already-resolved pointer directly.
        Log.writeLine(LogLevels.TestDebug, "One matching property found - will update/delete property");
        jsonPointer = matchingProperties[0].pointer;
      }
      if (value === this.SENTINEL_UNDEFINED) {
        // Caller wants to delete the property identified by jsonPointer. Work out the final
        // path segment (the property/index name itself) from the pointer.
        const deadProperty = jsonPointer.split("/").pop() as string;
        Log.writeLine(LogLevels.TestDebug, `value is _undefined so will delete property [${jsonPointer}]`);
        if (Array.isArray(matchingProperties[0].parent)) {
          // Parent is an array — removing a numeric index via `delete` would leave a hole
          // (an actual `undefined` slot) rather than shortening the array, so splice instead.
          Log.writeLine(LogLevels.TestDebug, `Deleting [${matchingProperties[0].parent}] is an array.  So remove by index....`);
          matchingProperties[0].parent.splice(Number(deadProperty), 1);
        } else {
          // Parent is a plain object — delete the property outright.
          Log.writeLine(LogLevels.TestDebug, `Deleting [${matchingProperties[0].parent}] is an NOT array.  So remove by deletion...`);
          // Caller wants to delete property...
          // http://perfectionkills.com/understanding-delete/
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          delete (matchingProperties[0].parent as any)[deadProperty]; // How can I do this WITHOUT going via any?
        }
      } else {
        // Caller wants to set (add or update) the property identified by jsonPointer to value.
        Log.writeLine(
          LogLevels.TestDebug,
          `Updating or adding property [${jsonPointer}] with value: ${typeof value === "object" ? "\n" + JSON.stringify(value as object, null, 2) : value}`
        );
        JSONPointer.set(modifiedObject, jsonPointer, value);
        // Read the value straight back and verify it really did get set to what was asked —
        // a defensive check against jsonPointer being subtly wrong (e.g. a bad path-to-array
        // conversion) silently no-op'ing instead of throwing.
        const setValue = JSONPointer.get(modifiedObject, jsonPointer);
        if (setValue !== value) {
          const errMessage = `After setting [${pathString}] to value: ${typeof value === "object" ? "\n" + JSON.stringify(value as object, null, 2) : `[${value}]`}\nCheck showed it was now:  ${typeof setValue === "object" ? "\n" + JSON.stringify(setValue as object, null, 2) : `[${setValue}]`}`;
          Log.logErrorAndThrow(errMessage);
        }
      }
      return modifiedObject;
    } catch (err) {
      const errText = `Error adding/updating/deleting property [${pathString}]: ${err}`;
      // Only write error out if we are Test Debug or lower.  No need for Test Information)
      if (Log.loggingLevel < LogLevels.TestInformation) {
        Log.writeLine(
          LogLevels.Error,
          `${errText}\nValue:${typeof value === "object" ? JSON.stringify(value as object, null, 2) : value}\nObject:\n${JSON.stringify(
            currentObject,
            null,
            2
          )}`,
          { maxLines: 1024 }
        );
      }
      throw new Error(errText);
    }
  }

  /**
   * Recursively resolves {@link SENTINEL_UNDEFINED}/{@link SENTINEL_NULL} string sentinels
   * found anywhere within a value — removing the owning property for `"_undefined"`,
   * substituting a real `null` for `"_null"` — and returns the result. The source value is
   * never mutated. A subtree that contains no sentinel anywhere within it is returned as
   * the exact same reference it was given (no gratuitous copying of ordinary data that
   * needed no resolving) — only a subtree actually containing a sentinel gets rebuilt.
   *
   * Exists so any caller building a value from a source that can only express plain strings
   * — a Cucumber DataTable cell, a JSON literal, a file's contents — gets a uniform way to
   * express "remove this property" or "a real null, not the text" regardless of which of
   * those sources it came from, and regardless of how deep it's nested. Deliberately a
   * single, reusable pass here in `@controlium/utils` rather than something every caller
   * (header configuration, future JSON-body construction, anything else) reimplements or
   * remembers to call independently.
   *
   * Only ever inspects *string* values — `_undefined`/`_null` are recognised exactly, with
   * no trimming or case-insensitivity, so there's no ambiguity with a string a test
   * genuinely wants to send verbatim (e.g. `"_null "` with trailing whitespace, or
   * `"_UNDEFINED"`, pass through completely unchanged).
   *
   * Cycle-safe: a value that is its own ancestor (a circular reference) is returned
   * unprocessed at the point the cycle is detected, rather than recursing forever. Plain
   * header/JSON data is never circular, but this is `@controlium/utils` — a caller handing
   * in something malformed (bypassing the type system, or built from genuinely corrupt
   * data) must never turn "resolve a few sentinels" into a stack overflow.
   *
   * @param value - The value to resolve sentinels within — a plain object, array, or
   *   primitive. Typically the result of merging a JSON literal/file/DataTable-sourced
   *   object, called *after* any merge so a sentinel in the new data can act on the
   *   already-merged result (e.g. removing a property that only existed before the merge).
   * @returns The resolved value, same shape as the input, with every `"_undefined"`
   *   property removed and every `"_null"` value replaced with a real `null`.
   *
   * @example
   * JsonUtils.resolveSentinels({ Authorization: "_undefined", "X-Trace": "_null" });
   * // => { "X-Trace": null }   (Authorization removed entirely)
   *
   * @example
   * JsonUtils.resolveSentinels({ user: { name: "Alice", nickname: "_undefined" } });
   * // => { user: { name: "Alice" } }   (nested properties resolved too)
   */
  static resolveSentinels<T>(value: T): T {
    return this.resolveSentinelsWithinSeen(value, new Set());
  }

  /**
   * Internal recursion backing {@link resolveSentinels} — identical contract, plus a `seen`
   * set (ancestors currently being processed, for cycle detection) threaded through calls.
   * Kept private so {@link resolveSentinels}'s own public signature stays single-parameter.
   */
  private static resolveSentinelsWithinSeen<T>(value: T, seen: Set<object>): T {

    ////////////////////////////////////////////////////
    //
    // Dispatches on value's own runtime shape (string / array / plain object / anything
    // else), recursing into arrays and objects while tracking "currently-being-processed"
    // ancestors in `seen` so a circular reference is returned as-is at the point the cycle
    // is detected, rather than recursing forever. Only rebuilds a subtree if something
    // inside it actually changed — an unchanged subtree is returned as the exact same
    // reference it was given.

    // A string is either the SENTINEL_NULL sentinel (resolve to a real null) or passes
    // through completely unchanged — this is the actual base case of the recursion.
    if (typeof value === "string") {
      return (value === this.SENTINEL_NULL ? null : value) as T;
    }
    if (Array.isArray(value)) {
      // Already processing this exact array higher up the call stack — it's a cycle, so
      // return it as-is rather than recursing into it again.
      if (seen.has(value)) return value;
      seen.add(value);
      let changed = false;
      // Recurse into each element, tracking whether any element actually changed.
      const result = value.map((item) => {
        const resolvedItem = this.resolveSentinelsWithinSeen(item, seen);
        if (resolvedItem !== item) changed = true;
        return resolvedItem;
      });
      // Done processing this array — remove it from the in-progress set so a *different*
      // branch of the tree that happens to reference the same array isn't wrongly treated
      // as a cycle.
      seen.delete(value);
      // Only return the newly-built array if something inside it actually changed;
      // otherwise return the original reference unchanged.
      return (changed ? result : value) as T;
    }
    if (value !== null && typeof value === "object") {
      // Same cycle-detection as the array branch above, but for plain objects.
      if (seen.has(value)) return value;
      seen.add(value);
      let changed = false;
      const result: Record<string, unknown> = {};
      // Walk each property: a SENTINEL_UNDEFINED value means "omit this property entirely"
      // (skip adding it to result), anything else gets resolved recursively and kept.
      for (const [key, propertyValue] of Object.entries(value as Record<string, unknown>)) {
        if (propertyValue === this.SENTINEL_UNDEFINED) {
          changed = true;
          continue;
        }
        const resolvedValue = this.resolveSentinelsWithinSeen(propertyValue, seen);
        if (resolvedValue !== propertyValue) changed = true;
        result[key] = resolvedValue;
      }
      // Done processing this object — remove it from the in-progress set, same reasoning as
      // the array branch above.
      seen.delete(value);
      // Only return the newly-built object if something inside it actually changed;
      // otherwise return the original reference unchanged.
      return (changed ? result : value) as T;
    }
    // Anything else (number, boolean, null, undefined) has no sentinel meaning — pass
    // through unchanged.
    return value;
  }

  /**
   * Flattens an array of plain key/value "row" objects into a single flat object, using one
   * named column as the resulting property name and another as its value.
   *
   * Deliberately knows nothing about Cucumber, or any other test runner — the input here is
   * already just an array of plain objects (e.g. the result of calling a Cucumber `DataTable`'s
   * own `.hashes()`). Any runner whose own tabular construct can be converted to this same
   * `Record<string, string>[]` shape gets identical flattening behaviour for free, with
   * nothing runner-specific past that conversion.
   *
   * Does not interpret `valueColumnName`'s values in any way (no sentinel resolution, no type
   * casting) — every value comes out exactly as it went in. Callers that need
   * `"_undefined"`/`"_null"` resolved, or non-string values cast, do that separately on the
   * result (e.g. {@link resolveSentinels}).
   *
   * @param rows - The rows to flatten. Each row must be a non-null, non-array object
   *   containing both `keyColumnName` and `valueColumnName` as actual properties.
   * @param keyColumnName - The column whose value becomes the resulting object's property name.
   * @param valueColumnName - The column whose value becomes the resulting property's value.
   * @returns A flat object built from every row's `{ [keyColumnName]: [valueColumnName] }` pair.
   * @throws {Error} If `rows` is not an array; if any row is not a non-null, non-array object;
   *   if any row is missing `keyColumnName` or `valueColumnName`; if a row's key-column value
   *   is blank; or if the same key appears in more than one row. The last two are deliberately
   *   not guessed at silently (override? keep the first? build an array?) — all genuinely
   *   plausible, so this throws rather than picking one on a caller's behalf.
   *
   * @example
   * JsonUtils.buildObjectFromRows(
   *   [{ "Header Key": "Authorization", "Value": "Bearer abc" }, { "Header Key": "X-Trace", "Value": "123" }],
   *   "Header Key",
   *   "Value"
   * );
   * // => { Authorization: "Bearer abc", "X-Trace": "123" }
   */
  static buildObjectFromRows(
    rows: Record<string, string>[],
    keyColumnName: string,
    valueColumnName: string
  ): Record<string, string> {

    ////////////////////////////////////////////////////
    //
    // Validates the two column names and the rows array itself up front, then walks each
    // row in turn, validating its shape and both named columns' presence before using them
    // — building up a flat result object one row at a time, and refusing outright (rather
    // than silently picking a behaviour) on anything genuinely ambiguous, like a blank key
    // or the same key appearing twice.

    // Both column names must be non-empty strings — fail fast and clearly if not.
    Utils.assertShape(keyColumnName, "nonEmptyString", "JsonUtils.buildObjectFromRows", "keyColumnName");
    Utils.assertShape(valueColumnName, "nonEmptyString", "JsonUtils.buildObjectFromRows", "valueColumnName");
    // rows itself must actually be an array.
    if (!Array.isArray(rows)) {
      const errText = `Cannot JsonUtils.buildObjectFromRows as [rows] must be an array. Is [${Utils.describeValue(rows)}]`;
      Log.logErrorAndThrow(errText);
    }

    const result: Record<string, string> = {};
    // Walk every row, validating and flattening each one into result in turn.
    rows.forEach((row, index) => {
      // Each row must itself be a non-null, non-array plain object.
      if (row === null || typeof row !== "object" || Array.isArray(row)) {
        const errText = `Cannot JsonUtils.buildObjectFromRows as row [${index}] is not a non-null object. Is [${Utils.describeValue(row)}]`;
        Log.logErrorAndThrow(errText);
      }
      // The row must actually contain the key column.
      if (!(keyColumnName in row)) {
        const errText = `Cannot JsonUtils.buildObjectFromRows as row [${index}] has no column [${keyColumnName}]. Row: ${Utils.safeStringify(row)}`;
        Log.logErrorAndThrow(errText);
      }
      // The row must actually contain the value column.
      if (!(valueColumnName in row)) {
        const errText = `Cannot JsonUtils.buildObjectFromRows as row [${index}] has no column [${valueColumnName}]. Row: ${Utils.safeStringify(row)}`;
        Log.logErrorAndThrow(errText);
      }
      // The key column's value must be a non-blank string — it's about to become a property
      // name, and a blank one has no sensible meaning.
      const key = row[keyColumnName];
      if (typeof key !== "string" || key.trim().length === 0) {
        const errText = `Cannot JsonUtils.buildObjectFromRows as row [${index}]'s [${keyColumnName}] is blank. Row: ${Utils.safeStringify(row)}`;
        Log.logErrorAndThrow(errText);
      }
      // The same key appearing in more than one row is genuinely ambiguous (override? keep
      // the first? build an array?) — refuse rather than silently picking one on the
      // caller's behalf.
      if (key in result) {
        const errText = `Cannot JsonUtils.buildObjectFromRows as key [${key}] appears in more than one row — ambiguous (override, keep first, or build an array?). Row: ${Utils.safeStringify(row)}`;
        Log.logErrorAndThrow(errText);
      }
      // All checks passed — add this row's key/value pair to the result.
      result[key] = row[valueColumnName];
    });
    return result;
  }

  /**
   * Returns the number of properties within a JSON object that match the given JSONPath expression.
   *
   * @param jsonObject - The object to query.
   * @param pathString - A valid JSONPath expression identifying the properties to count.
   * @returns The number of matching properties, or `0` if none match.
   * @throws {Error} If `jsonObject` is not a valid JSON object.
   *
   * @example
   * JsonUtils.getMatchingJSONPropertyCount({ a: 1, b: 2 }, "$.a"); // => 1
   * JsonUtils.getMatchingJSONPropertyCount({ a: 1, b: 2 }, "$.*"); // => 2
   */
  static getMatchingJSONPropertyCount(jsonObject: object, pathString: string): number {

    ////////////////////////////////////////////////////
    //
    // Validates jsonObject is actually JSON, runs the JSONPath query via
    // getPropertiesMatchingPath, then returns just the match count rather than the full
    // match detail that method returns.

    // pathString must actually be a string — fail fast and clearly if not.
    Utils.assertType(pathString, "string", "JsonUtils.getMatchingJSONPropertyCount", "pathString");
    // jsonObject must actually be valid JSON — refuse otherwise.
    if (!this.isJson(jsonObject)) {
      Log.writeLine(LogLevels.Error, "Passed object is not a valid Json Object. Aborting");
      throw new Error("Passed object is not a valid Json Object");
    }

    // Run the query and keep only the count of what matched.
    const jsonProperties = this.getPropertiesMatchingPath(jsonObject, pathString);

    Log.writeLine(LogLevels.TestDebug, `[${pathString}] has [${jsonProperties.length}] matches`);
    return jsonProperties?.length ?? 0;
  }

  /**
   * Removes all properties matching the given key names from a JSON object, including
   * those nested within child objects or arrays. Operates directly on the passed object
   * (mutates in place).
   *
   * @param jsonObject - The object (or array of objects) to remove properties from.
   * @param removeKeys - One or more property names to remove at any depth.
   * @param throwError - When `true`, any error encountered during removal is re-thrown.
   *   When `false` (default), errors are logged and silently swallowed.
   *
   * @example
   * const obj = { a: 1, b: { a: 2, c: 3 } };
   * JsonUtils.removeJsonPropertyByKey(obj, ["a"]);
   * // obj => { b: { c: 3 } }
   */
  public static removeJsonPropertyByKey(jsonObject: object | Array<object>, removeKeys: string[], throwError = false) {

    ////////////////////////////////////////////////////
    //
    // Recursively walks jsonObject (mutating it in place, not a copy): for an array, recurse
    // into every element; for a plain object, delete any property whose key is in removeKeys
    // and recurse into every OTHER property's value (so a nested object/array still gets its
    // own matching keys removed even if it isn't itself being deleted). Anything else (a
    // primitive at the top level) is neither an error nor actionable — just logged.

    // removeKeys must actually be an array of strings — fail fast and clearly if not.
    if (!Array.isArray(removeKeys) || !removeKeys.every((key) => typeof key === "string")) {
      const errText = `Cannot JsonUtils.removeJsonPropertyByKey as [removeKeys] must be a string array. Is [${Utils.describeValue(removeKeys)}]`;
      Log.logErrorAndThrow(errText);
    }
    try {
      if (Array.isArray(jsonObject)) {
        // jsonObject is an array — recurse into each element in turn.
        Log.writeLine(LogLevels.TestDebug, "JSON Object is an array, itterating through array and removing required key/s from each item");
        for (const arrayItem of jsonObject) {
          this.removeJsonPropertyByKey(arrayItem, removeKeys);
        }
      } else if (typeof jsonObject === "object") {
        // jsonObject is a plain object — walk every removeKey against every one of its own
        // keys.
        Log.writeLine(LogLevels.TestDebug, `JSON Object is an object, removing key/s [${removeKeys.join(",")}]`);
        for (const removeKey of removeKeys) {
          for (const key of Object.keys(jsonObject)) {
            if (key === removeKey) {
              // This key matches one being removed — delete it outright.
              delete jsonObject[removeKey as keyof typeof jsonObject];
            } else {
              // Not a match at this level — recurse into its value anyway, in case it's an
              // object/array that itself contains a matching key further down.
              this.removeJsonPropertyByKey(jsonObject[key as keyof typeof jsonObject], removeKeys);
            }
          }
        }
      } else {
        // jsonObject is neither an array nor an object (e.g. called directly on a
        // primitive) — nothing to remove; just log it, not an error.
        Log.writeLine(
          LogLevels.Error,
          `Unable to remove Keys [${removeKeys.join(",")}] as json object is ${typeof jsonObject}.  Expected object or Array<object>`
        );
      }
    } catch (err) {
      // Something went wrong during removal — log it, and only re-throw if the caller
      // explicitly asked for errors to propagate (default is to swallow them).
      const errText = `Error in removing the property from JSON ${err}`;
      Log.writeLine(LogLevels.Error, errText);
      if (throwError) throw new Error(errText);
    }
  }

  /**
   * Escapes all RegExp special characters in a string so it can be safely used
   * as a literal pattern in a `RegExp` constructor.
   *
   * @param toBeEscaped - The string to escape.
   * @returns The input string with all RegExp special characters escaped.
   *
   * @example
   * JsonUtils.escapeRegExp("a.b+c"); // => "a\\.b\\+c"
   * new RegExp(JsonUtils.escapeRegExp("1+1=2")); // matches literal "1+1=2"
   */
  public static escapeRegExp(toBeEscaped: string): string {
    Utils.assertType(toBeEscaped, "string", "JsonUtils.escapeRegExp", "toBeEscaped");
    return toBeEscaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}