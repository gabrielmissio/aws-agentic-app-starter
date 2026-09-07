# Renders a cdk-nag report (infra/src/nag.ts) as GitHub-flavoured Markdown for the job summary.
#
# The number at the top is the point of this job. cdk-nag is wired report-only — see the header of
# `infra/src/nag.ts` for why gating on it would mean shipping a template whose forks inherit fifty
# pre-accepted suppressions — so nothing here fails, and the value is entirely in the count moving.
# A pull request that takes 53 to 55 has added two, and the tables below say which rule and where.
#
# `ruleName` arrives qualified, as `AwsSolutions-IAM5[Resource::*]`. Grouping strips the qualifier so
# thirty-one wildcard findings read as one row with a count rather than thirty-one near-identical
# ones; the qualifiers are what the detail section keeps.

def base: sub("\\[.*$"; "");
def sev($s): {error: "🔴", warning: "🟠"}[$s] // "🔵";

[.violations[] | . as $v | $v.violatingResources[] | {
  rule: ($v.ruleName | base),
  qualified: $v.ruleName,
  severity: ($v.severity // "error"),
  description: $v.description,
  path: .constructPath,
  stack: (.constructPath | split("/")[0])
}] as $f

| "## cdk-nag — AwsSolutions\n\n"
+ "**\($f | length) finding(s)** across \($f | map(.rule) | unique | length) rules"
+ " · report-only, this job does not gate\n\n"

# The count means nothing without the posture that produced it: the same app scans 53 findings with a
# developer's `.env` and 44 with none, and both call themselves `demo`. Two counts are comparable only
# when these rows match, so they are stated up front rather than left to be assumed.
+ (.posture // {} | to_entries
   | "<details><summary>Posture this was scanned under — compare counts only across matching runs</summary>\n\n"
     + "| Setting | Value |\n|---|---|\n"
     + (map("| `\(.key)` | \(if .value == null then "_unset_" elif .value == true then "set" elif .value == false then "_unset_" else "`\(.value)`" end) |") | join("\n"))
     + "\n\n</details>\n\n")

+ (if ($f | length) == 0 then "" else
    "| | Rule | # | What it is |\n|---|---|---:|---|\n"
    + ($f
       | group_by(.rule)
       | sort_by(-length)
       | map("| \(sev(.[0].severity)) | `\(.[0].rule)` | \(length) | \(.[0].description | .[0:120] | gsub("\\s+"; " ") | gsub("\\|"; "\\|")) |")
       | join("\n"))
    + "\n\n"
    + "| Stack | # |\n|---|---:|\n"
    + ($f | group_by(.stack) | sort_by(-length)
       | map("| `\(.[0].stack)` | \(length) |") | join("\n"))
    + "\n\n"
    + "<details><summary>Every finding, by resource</summary>\n\n"
    + "| Rule | Resource |\n|---|---|\n"
    + ($f | sort_by(.stack, .rule)
       | map("| `\(.qualified)` | `\(.path)` |") | join("\n"))
    + "\n\n</details>\n"
  end)
