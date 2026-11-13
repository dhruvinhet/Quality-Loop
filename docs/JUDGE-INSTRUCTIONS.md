# QualityLoop demo instructions

Use a **classic (company-managed) Jira project with Task and the Relates issue
link type enabled** for the supported sample demo. Use an account that can browse
and edit the example issues, create issues in the CAPA project, and link issues.
The owner handles Forge deployment and installation.

1. Open the project's **QualityLoop** page. Follow **How to try this**, create the
   sample scenario, review its listed writes and confirm. When ready, open the
   linked **DEMO new NC**, open QualityLoop from the apps icon and click **Save**.
2. Inspect the CAPA evidence, original/normalised part display and any hints.
   Hints explicitly are not matches. QualityLoop presents possible recurrence
   evidence and never declares a CAPA failed or changes its status through matching.
3. Record an engineer decision with a reason. To demonstrate follow-up, record
   **Effectiveness concern** on an eligible card. Review the next dialog: chosen
   issue type, description preview, CAPA and NC links, marker and assignee. Click
   **Create follow-up** only after reviewing these writes.
4. Open the created issue from decision history. Its description shows the NC key
   and summary as a link, CAPA key, decision type, engineer reason/category when
   present, valid HTTPS evidence links and instructions for opening full history.
   Its Relates links should include **both the CAPA and NC**.
5. If creation reports **created with limits**, retain that issue. Use **Verify
   link** in history and confirm its listed repairs. It fills only an empty
   description and missing links; it does not replace nonempty owner notes or
   create another issue. Older CAPA-only follow-ups also need this verification.

If Task is unavailable, the dialog names the first available standard type, such
as Story; project-specific required fields can still prevent creation. If Relates
is unavailable, follow-up creation can be confirmed as **unlinked**; enable
Relates in Jira and then use Verify link. The sample scenario itself still needs
its existing project prerequisites, so use Task + Relates for the demo above.

No background monitoring runs. Evidence and history are shown only for Jira
issues the viewing user can browse. Use sample/fictitious data for demonstration.
