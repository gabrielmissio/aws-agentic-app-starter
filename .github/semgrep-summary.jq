# Renders a Semgrep SARIF file as GitHub-flavoured Markdown for the job summary.
#
# Why a summary at all, when the scan already prints to the log: the console output reports
# "0 findings" and stops there. It says nothing about the findings that *were* matched and then
# suppressed at the line — and a `nosemgrep` whose justification has since stopped holding is exactly
# the thing a security gate should keep in front of a reviewer. SARIF carries those; the text format
# discards them. That asymmetry is the reason this file exists, and the reason the suppressed table
# below is not optional decoration.
#
# Written in jq rather than as a script in a language the repository already uses, because this runs
# in the one CI job that deliberately installs nothing: `sast` has no `node_modules`, so Semgrep has
# nothing of ours to waste time scanning. jq is on every GitHub runner.

def loc: .locations[0].physicalLocation
       | "\(.artifactLocation.uri):\(.region.startLine)";

def sev($lv): {error: "🔴 error", warning: "🟠 warning", note: "🔵 note"}[$lv] // $lv;

# Table cells are one line, and a pipe inside a message would otherwise end the column early.
def trim: .[0:160] | gsub("\\s+"; " ") | gsub("\\|"; "\\|");

.runs[0] as $r
| ($r.tool.driver.rules
   | map({key: .id, value: (.defaultConfiguration.level // "warning")})
   | from_entries) as $level

# A result carrying `suppressions` was matched and then silenced in source. Both halves are reported,
# and they are reported separately: one is a gate failure, the other is a standing decision.
| ($r.results | map(select((.suppressions // []) | length == 0))) as $open
| ($r.results | map(select((.suppressions // []) | length  > 0))) as $suppressed

| "## Semgrep\n\n"
+ (if ($open | length) == 0 then "**No findings.**" else "**\($open | length) finding(s).**" end)
+ " \($suppressed | length) suppressed in source"
+ " · \($r.tool.driver.rules | length) rules in `p/default`"
+ " · Semgrep \($r.tool.driver.semanticVersion // "unknown")\n\n"

+ (if ($open | length) > 0 then
    "| | Rule | Location | Finding |\n|---|---|---|---|\n"
    + ($open
       | map("| \(sev($level[.ruleId] // "warning")) | `\(.ruleId)` | `\(loc)` | \(.message.text | trim) |")
       | join("\n"))
    + "\n\n"
  else "" end)

+ (if ($suppressed | length) > 0 then
    "<details><summary>Suppressed with <code>nosemgrep</code> (\($suppressed | length)) — still worth a reader</summary>\n\n"
    + "| Rule | Location |\n|---|---|\n"
    + ($suppressed | map("| `\(.ruleId)` | `\(loc)` |") | join("\n"))
    + "\n\n</details>\n"
  else "" end)
