import YAML from "yaml";

import { Log, Utils } from "../index.js";

/**
 * YAML utility methods — parsing and serialising.
 *
 * Deliberately minimal for now: just the `JSON.parse`/`JSON.stringify` equivalent pair,
 * nothing from the underlying `yaml` package's own `Document`/comment-preserving mutation
 * API (`parseDocument`, `visit`, etc.). Nothing calls into that yet — DataTable-based
 * path modifications against a YAML base aren't wired up anywhere in the ecosystem yet
 * (`cucumber-driver`'s own file-sourced YAML body step is still an unimplemented stub); when
 * that gets built, *that* is the point to reach for `Document` instead of extending this,
 * since a naive parse → mutate plain object → re-stringify round trip silently destroys any
 * comments/blank-lines/formatting a test author put in a YAML fixture file, which
 * `Document`-based mutation preserves.
 */
export class YamlUtils {
  /**
   * Parses a YAML string into its resolved value — the YAML equivalent of `JSON.parse`.
   *
   * Always strict (`{ strict: true }`, pinned explicitly here rather than relying on the
   * `yaml` package's own default, so a future library upgrade can never silently change
   * this): malformed YAML throws a clear error rather than the library's own optional
   * "parse as much of it as it can" leniency mode. Same rule every other cast in this
   * ecosystem follows (`number:`/`boolean:`/`json:`/etc. — see `ValueExpression.parse`'s
   * own doc comment) — a test deliberately sending broken YAML wants that caught loudly,
   * not quietly salvaged;
   * confirmed directly against the library itself that this is also already its default,
   * this just pins it so a version bump can't change that from under us.
   *
   * @param yaml - The YAML string to parse.
   * @returns The parsed value — a string, number, boolean, `null`, plain object, or array.
   * @throws {Error} If `yaml` is not a string, or if it is not valid YAML.
   *
   * @example
   * YamlUtils.parse("a: 1\nb: two\n"); // => { a: 1, b: 'two' }
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static parse(yaml: string): any {
    // yaml must actually be a string — fail fast and clearly if not.
    Utils.assertType(yaml, "string", "YamlUtils.parse", "yaml");
    try {
      // Parse in strict mode — throws on malformed YAML rather than salvaging what it can.
      return YAML.parse(yaml, { strict: true });
    } catch (err) {
      // Parsing failed — log and throw a clearer error, including the yaml itself (or just
      // its length, if it's long enough that dumping it in full wouldn't be useful).
      const errTxt = `Cannot parse item [${yaml.length < 50 ? yaml : `Length ${yaml.length}`}] as YAML: ${Utils.errorMessage(err)}`;
      Log.logErrorAndThrow(errTxt);
    }
  }

  /**
   * Serialises a value back to a YAML string — the YAML equivalent of `JSON.stringify`.
   * `XmlUtils` needed its own version of this for the same reason (`JSON.stringify` is a
   * native global; neither XML nor YAML has an equivalent built in).
   *
   * @param value - The value to serialise.
   * @returns The serialised YAML string.
   *
   * @example
   * YamlUtils.stringify({ a: 1, b: "two" }); // => "a: 1\nb: two\n"
   */
  static stringify(value: unknown): string {
    return YAML.stringify(value);
  }

  /**
   * Checks whether `item` is valid YAML that parses to a real mapping or sequence — not a
   * bare scalar. Mirrors {@link JsonUtils.isJson}'s own "valid but a bare primitive
   * doesn't count" rule, for the same reason: YAML's grammar accepts almost any plain
   * text as a bare scalar (a single word, a sentence — even a JSON object or array,
   * since JSON is a YAML 1.2 subset), so without this rule nearly everything would count
   * as "valid YAML", making this check useless as a content-sniffing signal. This is
   * still inherently less precise than {@link JsonUtils.isJson}/{@link XmlUtils.isXml}
   * even with the rule — a block of plain text that happens to contain a `key: value`-
   * shaped line can still parse to a mapping — there's no fully reliable way to sniff
   * "is this really YAML" from content alone; this is the closest practical filter.
   *
   * @param item - The string to check.
   * @returns `true` if `item` parses as YAML to a non-null object or array.
   *
   * @example
   * YamlUtils.isYaml("a: 1");       // true
   * YamlUtils.isYaml("- 1\n- 2");   // true
   * YamlUtils.isYaml("hello");      // false (bare scalar)
   * YamlUtils.isYaml("a: [1, 2");   // false (malformed)
   */
  static isYaml(item: string | undefined | null): boolean {
    // null/undefined is never valid YAML.
    if (Utils.isNullOrUndefined(item)) return false;
    try {
      // Parse in strict mode, then only count a real mapping/sequence as "is YAML" — a bare
      // scalar (a plain word, a sentence) parses fine but isn't what this check is asking.
      const parsed = YAML.parse(item, { strict: true });
      return typeof parsed === "object" && parsed !== null;
    } catch {
      // Parsing failed — not valid YAML.
      return false;
    }
  }
}
