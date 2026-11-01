# QualityLoop privacy

QualityLoop stores quality details (record type, original and normalised part number, failure mode, supplier, line, dates, root cause, actions taken and effectiveness-evidence link) in the `qualityloop` issue property in Jira. Jira controls access to the issue and its properties. Evidence links are stored as links; QualityLoop does not fetch their contents.

Decisions are stored in Forge hosted Custom Entity Store storage. A decision contains the NC and CAPA issue IDs, decision type, the author's Atlassian account ID, reason and reason category where applicable, evidence links, timestamps, and an optional follow-up task key and creation claim. Pair-state records hold the related NC and CAPA IDs, current decision state, version, latest decision ID and update timestamp.

The optional sample scenario stores a `sample:<projectId>` key in the Forge hosted Key-Value Store. It contains the created issue IDs and keys, the creator's account ID, sample definitions and progress needed to create and remove the scenario safely. A sample is created only after confirmation. Its five labelled Jira issues contain illustrative quality data.

Short-lived Forge KVS records hold confirmation plans, removal progress, per-project operation locks and admin orphan-review lists. Review records are scoped to the requesting account and expire after an hour. They contain IDs and operation metadata, not copies of Jira summaries. Forge may physically remove expired records later. Operational errors may be logged in Forge; QualityLoop does not deliberately log quality narratives or evidence links.

There is no external network egress, external storage, AI processing or analytics. QualityLoop uses Atlassian-hosted Jira and Forge services. Following an evidence link is a separate action in your browser.

When a Jira issue is deleted, QualityLoop makes a best-effort attempt to remove decisions and pair-state records referring to it. Event delivery, permission limits, search-index delays or service errors can leave records behind. Jira administrators can use **QualityLoop data → Find orphaned records → Delete orphaned records** to remove records whose issue or CAPA returns a Jira 404. The scan shows counts and IDs only, and does not change Jira issues. Permission errors and other uncertain responses do not trigger deletion. The scan also fills missing IDs in older pair-state records without changing their decisions.

**Remove sample scenario** deletes only registered issue IDs that still have the `qualityloop-sample` label and that the acting user can delete. It removes their matching app records and clears the sample registration. Issues that cannot be deleted remain in Jira and are reported; inaccessible issues are not identified. An interrupted create may leave an issue whose ID was never returned to the app; the page warns the user to check the sample label in Jira. Jira removes issue properties with the issue. The admin page removes orphaned app records, not quality fields on existing issues.

After uninstall, Atlassian's retention and deletion rules apply to Forge hosted data. Uninstalling does not itself delete existing Jira issues. See [Data lifecycle for Forge-hosted storage](https://developer.atlassian.com/platform/forge/storage-reference/hosted-storage-data-lifecycle/) for Atlassian's current policy, including soft deletion and recovery.

Contact: **[dhruvin1309@gmail.com]**
