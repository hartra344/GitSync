const fs = require("fs");
const log = require("loglevel");
const core = require("@actions/core");
const github = require("@actions/github");
const azdo = require("azure-devops-node-api");
const showdown = require("showdown");
showdown.setFlavor("github");

const JSDOM = require("jsdom").JSDOM;
globalThis.window = new JSDOM("", {}).window;

module.exports = class GitSync {
  constructor(level = "silent") {
    log.setLevel(level, true);
  }

  // skipcq: TCV-001
  async run() {
    try {
      const context = github.context;
      const env = process.env;

      let config = this.getConfig(context.payload, env);
      log.debug(config);

      // Temporary fix until support of PRs
      if (
        config?.issue?.node_id?.startsWith("PR_") ||
        config?.issue?.nodeId?.startsWith("PR_")
      ) {
        // Log and skip PRs (comments)
        log.info(
          `Action is performed on PR #${config.issue.number}. Skipping...`
        );
      } else {
        await this.performWork(config);
      }
    } catch (exc) {
      log.error(exc);
    }
  }

  getConfig(payload, env) {
    let configJSON = {};

    if (env.config_file) {
      try {
        let configFile = fs.readFileSync(env.config_file);
        configJSON = JSON.parse(configFile);

        log.debug("JSON configuration file loaded."); // skipcq JS-0002
      } catch {
        log.error("JSON configuration file not found."); // skipcq JS-0002
      }
    }

    let inputAdo = !!core.getInput("ado")
      ? JSON.parse(core.getInput("ado"))
      : { ado: {} };
    let inputGitHub = !!core.getInput("github")
      ? JSON.parse(core.getInput("github"))
      : { github: {} };
    let config = {
      log_level:
        configJSON && configJSON.log_level ? configJSON.log_level : undefined,
      ...payload,
      ...env,
      ado: {
        ...(configJSON && configJSON.ado ? configJSON.ado : {}),
        ...inputAdo.ado,
      },
      github: {
        ...(configJSON && configJSON.github ? configJSON.github : {}),
        ...inputGitHub.github,
      },
    };

    config.ado.orgUrl = `https://dev.azure.com/${config.ado.organization}`;

    if (!!config.ado_token && !!config.ado) {
      config.ado.token = config.ado_token;
    }
    if (!!config.github_token && !!config.github) {
      config.github.token = config.github_token;
    }

    if (config.log_level != undefined) {
      console.log(`Setting logLevel to ${config.log_level.toLowerCase()}...`); // skipcq JS-0002
      log.setLevel(config.log_level.toLowerCase(), true);
    } else {
      log.setLevel("info", true);
    }

    return config;
  }

  getConnection(config) {
    return new azdo.WebApi(
      config.ado.orgUrl,
      azdo.getPersonalAccessTokenHandler(config.ado.token)
    );
  }

  cleanUrl(url) {
    return url.replace("api.github.com/repos/", "github.com/");
  }

  createLabels(seed, labelsObj) {
    let labels = seed;
    if (!labelsObj) return labels;

    labelsObj.forEach((label) => {
      labels += `GitHub Label: ${label.name};`;
    });

    return labels;
  }

  getAssignee(config, useDefault) {
    let assignee = null;

    if (
      !!config?.issue?.assignee &&
      !!config.ado.mappings &&
      !!config.ado.mappings.handles
    ) {
      if (!!config.ado.mappings.handles[config.issue?.assignee?.login]) {
        assignee = config.ado.mappings.handles[config.issue?.assignee?.login];
      }
    }

    if (!!assignee) {
      return assignee;
    } else {
      if (!!config.assignee) {
        log.debug(
          `No mapping found for handle '${config.issue?.assignee?.login}'...`
        );
      }

      if (useDefault && !!config.ado.assignedTo) {
        return config.ado.assignedTo;
      }
    }

    return assignee;
  }

  async performWork(config) {
    let workItem = null;
    if(config.issue?.labels?.some(x => x.name?.toLowerCase() === "noado")) {
      workItem = await this.deleteWorkItem(config);
      return workItem;
    }
    switch (config.action) {
      case "opened":
        workItem = await this.createWorkItem(config);
        break;
      case "closed":
        workItem = await this.closeWorkItem(config);
        break;
      case "deleted":
        workItem = await this.deleteWorkItem(config);
        break;
      case "reopened":
        workItem = await this.reopenWorkItem(config);
        break;
      case "edited":
        workItem = await this.editWorkItem(config);
        break;
      case "labeled":
        workItem = await this.labelWorkItem(config);
        break;
      case "unlabeled":
        workItem = await this.unlabelWorkItem(config);
        break;
      case "assigned":
        workItem = await this.assignWorkItem(config);
        break;
      case "unassigned":
        workItem = await this.unassignWorkItem(config);
        break;
      case "created":
        workItem = await this.addComment(config);
        break;
    }

    if (!!config.schedule || !!config.inputs?.manual_trigger) {
      await this.updateIssues(config);
    }

    return workItem;
  }

  async getWorkItem(config, skipQuery = false) {
    if (skipQuery) {
      log.info("Skipping query...");
      return null;
    }

    log.info("Searching for work item...");

    let conn = this.getConnection(config);
    let client = null;
    let result = null;
    let workItem = null;

    try {
      client = await conn.getWorkItemTrackingApi();
    } catch (exc) {
      log.error("Error: cannot connect to organization.");
      log.error(exc);
      core.setFailed(exc);
      return -1;
    }

    let context = { project: config.ado.project };
    let wiql = {
      query:
        "SELECT [System.Id], [System.Description], [System.Title], [System.AssignedTo], [System.State], [System.Tags] FROM workitems WHERE [System.TeamProject] = @project " +
        "AND [System.WorkItemType] = '" +
        config.ado.wit +
        "'" +
        `AND [System.Tags] CONTAINS 'GitHub Issue #${config.issue.number}' ` +
        "AND [System.Tags] CONTAINS 'GitHub Repo: " +
        config.repository.full_name +
        "'",
    };

    try {
      result = await client.queryByWiql(wiql, context);

      if (result === null) {
        log.error("Error: project name appears to be invalid.");
        core.setFailed("Error: project name appears to be invalid.");
        return -1;
      }
    } catch (exc) {
      log.error("Error: unknown error while searching for work item.");
      log.error(exc);
      core.setFailed(exc);
      return -1;
    }

    if (result.workItems.length > 1) {
      log.warn("More than one work item found. Taking the first one.");
      workItem = result.workItems[0];
    } else {
      workItem = result.workItems.length > 0 ? result.workItems[0] : null;
    }

    if (workItem !== null) {
      log.info("Work item found:", workItem.id);
      try {
        return await client.getWorkItem(workItem.id, null, null, 4);
      } catch (exc) {
        log.error("Error: failure getting work item.");
        log.error(exc);
        core.setFailed(exc);
        return -1;
      }
    } else {
      log.info("Work item not found.");
      return null;
    }
  }

  async createWorkItem(config, skipQuery = false) {
    log.info("Creating work item...");

    return this.getWorkItem(config, skipQuery).then(async (workItem) => {
      if (!!workItem) {
        log.warn(
          `Warning: work item (#${workItem.id}) already exists. Canceling creation.`
        );
        return 0;
      }

      let converter = new showdown.Converter();
      const html = converter.makeHtml(config.issue.body);

      converter = null;

      // create patch doc
      let patchDoc = [
        {
          op: "add",
          path: "/fields/System.Title",
          value: config.issue.title,
        },
        {
          op: "add",
          path: "/fields/System.Description",
          value: !!html ? html : "",
        },
        {
          op: "add",
          path: "/fields/Microsoft.VSTS.TCM.ReproSteps",
          value: !!html ? html : "",
        },
        {
          "op": "add",
          "path": "/relations/-",
          "value": {
              "rel": "System.LinkTypes.Hierarchy-Reverse",//Add a parent link
              "url": "https://dev.azure.com/msazure/one/_apis/wit/workItems/24493735"
          }
        },
        {
          op: "add",
          path: "/fields/System.Tags",
          value: this.createLabels(
            `GitHub Issue #${config.issue.number};GitHub Repo: ${config.repository.full_name};`,
            config.issue.labels
          ),
        },
        {
          op: "add",
          path: "/relations/-",
          value: {
            rel: "Hyperlink",
            url: this.cleanUrl(config.issue.url),
          },
        },
        {
          op: "add",
          path: "/fields/System.History",
          value: `GitHub issue #${
            config.issue.number
          }: <a href="${this.cleanUrl(config.issue.url)}" target="_new">${
            config.issue.title
          }</a> created in <a href="${this.cleanUrl(
            config.issue.repository_url
          )}" target="_blank">${config.repository.full_name}</a> by <a href="${
            config.issue.user.html_url
          }" target="_blank">${config.issue.user.login}</a>`,
        },
      ];

      // set assigned to
      const assignee = this.getAssignee(config, true);
      if (assignee) {
        patchDoc.push({
          op: "add",
          path: "/fields/System.AssignedTo",
          value: this.getAssignee(config, true),
        });
      }

      // set area path if provided
      if (!!config.ado.areaPath) {
        patchDoc.push({
          op: "add",
          path: "/fields/System.AreaPath",
          value: config.ado.areaPath,
        });
      }

      // set iteration path if provided
      if (!!config.ado.iterationPath) {
        patchDoc.push({
          op: "add",
          path: "/fields/System.IterationPath",
          value: config.ado.iterationPath,
        });
      }

      // if bypass rules, set user name
      if (!!config.ado.bypassRules) {
        patchDoc.push({
          op: "add",
          path: "/fields/System.CreatedBy",
          value: config.issue.user.login,
        });
      }

      let conn = this.getConnection(config);
      let client = await conn.getWorkItemTrackingApi();
      let result = null;

      try {
        result = await client.createWorkItem(
          [],
          patchDoc,
          config.ado.project,
          config.ado.wit,
          false,
          config.ado.bypassRules
        );

        if (result === null) {
          log.error("Error: failure creating work item.");
          log.error(`WIT may not be correct: ${config.ado.wit}`);
          core.setFailed();
          return -1;
        }
        log.info("Successfully created work item:", result.id);

        return result;
      } catch (exc) {
        log.error("Error: failure creating work item.");
        log.error(exc);
        core.setFailed(exc);
        return -1;
      }
    });
  }

  async closeWorkItem(config) {
    log.info("Closing work item...");

    let patchDoc = [
      {
        op: "add",
        path: "/fields/System.State",
        value: config.ado.states.closed,
      },
    ];

    if (config.closed_at != "") {
      patchDoc.push({
        op: "add",
        path: "/fields/System.History",
        value: `GitHub issue #${config.issue.number}: <a href="${this.cleanUrl(
          config.issue.url
        )}" target="_new">${config.issue.title}</a> in <a href="${this.cleanUrl(
          config.issue.repository_url
        )}" target="_blank">${
          config.repository.full_name
        }</a> closed by <a href="${
          config.issue.user.html_url
        }" target="_blank">${config.issue.user.login}</a>`,
      });
    }

    return await this.updateWorkItem(config, patchDoc);
  }

  async deleteWorkItem(config) {
    log.info("Deleting work item...");

    let patchDoc = [
      {
        op: "add",
        path: "/fields/System.State",
        value: config.ado.states.deleted,
      },
      {
        op: "add",
        path: "/fields/IntuneAgile.ResolutionReason",
        value: "Won't Fix"
      },
      {
        op: "add",
        path: "/fields/System.History",
        value: `GitHub issue #${config.issue.number}: <a href="${this.cleanUrl(
          config.issue.url
        )}" target="_new">${config.issue.title}</a> in <a href="${this.cleanUrl(
          config.issue.repository_url
        )}" target="_blank">${
          config.repository.full_name
        }</a> removed by <a href="${
          config.issue.user.html_url
        }" target="_blank">${config.issue.user.login}</a>`,
      },
    ];

    return await this.updateWorkItem(config, patchDoc);
  }

  async reopenWorkItem(config) {
    log.info("Reopening work item...");

    let patchDoc = [
      {
        op: "add",
        path: "/fields/System.State",
        value: config.ado.states.reopened,
      },
      {
        op: "add",
        path: "/fields/System.History",
        value: `GitHub issue #${config.issue.number}: <a href="${this.cleanUrl(
          config.issue.url
        )}" target="_new">${config.issue.title}</a> in <a href="${this.cleanUrl(
          config.issue.repository_url
        )}" target="_blank">${
          config.repository.full_name
        }</a> reopened by <a href="${
          config.issue.user.html_url
        }" target="_blank">${config.issue.user.login}</a>`,
      },
    ];

    return await this.updateWorkItem(config, patchDoc);
  }

  async editWorkItem(config) {
    log.info("Editing work item...");

    let converter = new showdown.Converter();
    const html = converter.makeHtml(config.issue.body);

    converter = null;

    let patchDoc = [
      {
        op: "replace",
        path: "/fields/System.Title",
        value: config.issue.title,
      },
      {
        op: "replace",
        path: "/fields/System.Description",
        value: !!html ? html : "",
      },
      {
        op: "replace",
        path: "/fields/Microsoft.VSTS.TCM.ReproSteps",
        value: !!html ? html : "",
      },
      {
        op: "add",
        path: "/fields/System.History",
        value: `GitHub issue #${config.issue.number}: <a href="${this.cleanUrl(
          config.issue.url
        )}" target="_new">${config.issue.title}</a> in <a href="${this.cleanUrl(
          config.issue.repository_url
        )}" target="_blank">${
          config.repository.full_name
        }</a> edited by <a href="${
          config.issue.user.html_url
        }" target="_blank">${config.issue.user.login}</a>`,
      },
    ];

    return await this.updateWorkItem(config, patchDoc);
  }

  async labelWorkItem(config) {
    log.info("Adding label to work item...");

    let patchDoc = [
      {
        op: "add",
        path: "/fields/System.Tags",
        value: this.createLabels("", [config.label]),
      },
      {
        op: "add",
        path: "/fields/System.History",
        value: `GitHub issue #${config.issue.number}: <a href="${this.cleanUrl(
          config.issue.url
        )}" target="_new">${config.issue.title}</a> in <a href="${this.cleanUrl(
          config.issue.repository_url
        )}" target="_blank">${
          config.repository.full_name
        }</a> addition of label '${config.label.name}' by <a href="${
          config.issue.user.html_url
        }" target="_blank">${config.issue.user.login}</a>`,
      },
    ];

    return await this.updateWorkItem(config, patchDoc);
  }

  async unlabelWorkItem(config) {
    log.info("Removing label from work item...");

    return this.getWorkItem(config).then(async (workItem) => {
      if (!workItem) {
        log.warn(
          `Warning: cannot find work item (GitHub Issue #${config.issue.number}). Canceling update.`
        );
        return 0;
      }

      let patchDoc = [
        {
          op: "replace",
          path: "/fields/System.Tags",
          value: workItem.fields["System.Tags"].replace(
            this.createLabels("", [config.label]),
            ""
          ),
        },
        {
          op: "add",
          path: "/fields/System.History",
          value: `GitHub issue #${
            config.issue.number
          }: <a href="${this.cleanUrl(config.issue.url)}" target="_new">${
            config.issue.title
          }</a> in <a href="${this.cleanUrl(
            config.issue.repository_url
          )}" target="_blank">${
            config.repository.full_name
          }</a> removal of label '${config.label.name}' by <a href="${
            config.issue.user.html_url
          }" target="_blank">${config.issue.user.login}</a>`,
        },
      ];

      return await this.updateWorkItem(config, patchDoc);
    });
  }

  async assignWorkItem(config) {
    log.info("Assigning work item...");
    let assignee = this.getAssignee(config, false);
    let patchDoc = [];

    if (!!assignee) {
      patchDoc.push({
        op: "add",
        path: "/fields/System.AssignedTo",
        value: assignee,
      });
    } else {
      patchDoc.push({
        op: "remove",
        path: "/fields/System.AssignedTo",
      });
    }

    patchDoc.push({
      op: "add",
      path: "/fields/System.History",
      value: `GitHub issue #${config.issue.number}: <a href="${this.cleanUrl(
        config.issue.url
      )}" target="_new">${config.issue.title}</a> in <a href="${this.cleanUrl(
        config.issue.repository_url
      )}" target="_blank">${config.repository.full_name}</a> assigned to '${
        config.issue?.assignee?.login
      }' by <a href="${config.issue.user.html_url}" target="_blank">${
        config.issue.user.login
      }</a>`,
    });

    return await this.updateWorkItem(config, patchDoc);
  }

  async unassignWorkItem(config) {
    log.info("Unassigning work item...");

    let patchDoc = [
      {
        op: "remove",
        path: "/fields/System.AssignedTo",
      },
      {
        op: "add",
        path: "/fields/System.History",
        value: `GitHub issue #${config.issue.number}: <a href="${this.cleanUrl(
          config.issue.url
        )}" target="_new">${config.issue.title}</a> in <a href="${this.cleanUrl(
          config.issue.repository_url
        )}" target="_blank">${
          config.repository.full_name
        }</a> removal of assignment to '${
          config.issue?.assignee?.login
        }' by <a href="${config.issue.user.html_url}" target="_blank">${
          config.issue.user.login
        }</a>`,
      },
    ];

    return await this.updateWorkItem(config, patchDoc);
  }

  async addComment(config) {
    log.info("Adding comment to work item...");

    let converter = new showdown.Converter();
    const html = converter.makeHtml(config.comment.body);

    converter = null;

    let patchDoc = [
      {
        op: "add",
        path: "/fields/System.History",
        value:
          `GitHub issue #${config.issue.number}: <a href="${this.cleanUrl(
            config.issue.url
          )}" target="_new">${
            config.issue.title
          }</a> in <a href="${this.cleanUrl(
            config.issue.repository_url
          )}" target="_blank">${
            config.repository.full_name
          }</a> comment added by <a href="${
            config.comment.user.html_url
          }" target="_blank">${config.comment.user.login}</a><br />` +
          `Comment #<a href="${config.comment.html_url}" target="_blank">${config.comment.id}</a>:<br /><br />${html}`,
      },
    ];

    return await this.updateWorkItem(config, patchDoc);
  }

  async updateWorkItem(config, patchDoc) {
    return this.getWorkItem(config).then(async (workItem) => {
      if (!workItem) {
        if (!!config.ado.autoCreate) {
          log.warn(
            `Warning: cannot find work item (GitHub Issue #${config.issue.number}). Creating.`
          );
          workItem = await this.createWorkItem(config, true);
        } else {
          log.warn(
            `Warning: cannot find work item (GitHub Issue #${config.issue.number}). Canceling update.`
          );
          return 0;
        }
      }

      let conn = this.getConnection(config);
      let client = await conn.getWorkItemTrackingApi();
      let result = null;

      try {
        result = await client.updateWorkItem(
          [],
          patchDoc,
          workItem.id,
          config.ado.project,
          false,
          config.ado.bypassRules
        );

        log.info("Successfully updated work item:", result.id);

        return result;
      } catch (exc) {
        log.error("Error: failure updating work item.");
        log.error(exc);
        core.setFailed(exc);
        return -1;
      }
    });
  }

  async updateIssues(config) {
    log.info("Updating issues...");

    let conn = this.getConnection(config);
    let client = null;
    let result = null;
    let workItems = null;

    try {
      client = await conn.getWorkItemTrackingApi();
    } catch (exc) {
      log.error("Error: cannot connect to organization.");
      log.error(exc);
      core.setFailed(exc);
      return -1;
    }

    let context = { project: config.ado.project };
    let wiql = {
      query:
        "SELECT [System.Id], [System.Description], [System.Title], [System.AssignedTo], [System.State], [System.Tags] FROM workitems WHERE [System.TeamProject] = @project " +
        "AND [System.WorkItemType] = '" +
        config.ado.wit +
        "'" +
        "AND [System.Tags] CONTAINS 'GitHub Repo: " +
        config.GITHUB_REPOSITORY +
        "' " +
        "AND [System.ChangedDate] > @Today - 1",
    };

    try {
      result = await client.queryByWiql(wiql, context);

      if (result === null) {
        log.error("Error: project name appears to be invalid.");
        core.setFailed("Error: project name appears to be invalid.");
        return -1;
      }
    } catch (exc) {
      log.error("Error: unknown error while searching for work item.");
      log.error(exc);
      core.setFailed(exc);
      return -1;
    }

    workItems = result.workItems;
    workItems.forEach(async (workItem) => {
      await this.updateIssue(config, client, workItem);
    });
  }

  objectFlip(obj) {
    const ret = {};
    Object.keys(obj).forEach((key) => {
      ret[obj[key]] = key;
    });
    return ret;
  }

  updateIssue(config, client, workItem) {
    log.info(`Updating issue for work item (${workItem.id})...`);
    const octokit = new github.getOctokit(config.github.token);
    const owner = config.GITHUB_REPOSITORY_OWNER;
    const repo = config.GITHUB_REPOSITORY.replace(owner + "/", "");
    const converter = new showdown.Converter();

    log.debug(`[WORKITEM: ${workItem.id}] Owner:`, owner);
    log.debug(`[WORKITEM: ${workItem.id}] Repo:`, repo);

    return client
      .getWorkItem(workItem.id, [
        "System.Title",
        "System.Description",
        "System.State",
        "System.ChangedDate",
        "System.AssignedTo",
        "System.Tags",
      ])
      .then(async (wiObj) => {
        let issue_number = wiObj.fields["System.Tags"]
          .split(";")
          ?.find((x) => x.includes("GitHub Issue #"))
          ?.split("#")[1];

        if (!issue_number) {
          log.debug(
            `[WORKITEM: ${workItem.id}] No issue number found. Skipping...`
          );
          return null;
        }
        log.debug(
          `[WORKITEM: ${workItem.id} / ISSUE: ${issue_number}] Issue Number:`,
          issue_number
        );

        // Get issue
        const issue = (
          await octokit.rest.issues.get({
            owner,
            repo,
            issue_number,
          })
        ).data;

        log.debug(
          `[WORKITEM: ${workItem.id} / ISSUE: ${issue_number}] Issue:`,
          issue
        );

        // Check which is most recent
        // If WorkItem is more recent than Issue, update Issue
        // There is a case that WorkItem was updated by Issue, which is why it's more recent
        // Currently checks to see if title, description/body, and state are the same. If so (which means the WorkItem matches the Issue), no updates are necessary
        // Can later add check to see if last entry in history of WorkItem was indeed updated by GitHub
        if (
          new Date(wiObj.fields["System.ChangedDate"]) >
          new Date(issue.updated_at) &&
          !issue.labels?.some(x => x.name?.toLowerCase() === "noado")
        ) {
          log.debug(
            `[WORKITEM: ${
              workItem.id
            } / ISSUE: ${issue_number}] WorkItem.ChangedDate (${new Date(
              wiObj.fields["System.ChangedDate"]
            )}) is more recent than Issue.UpdatedAt (${new Date(
              issue.updated_at
            )}). Updating issue...`
          );
          let title = wiObj.fields["System.Title"];
          let body = converter
            .makeMarkdown(wiObj.fields["System.Description"] ?? "")
            .replace(/<br>/g, "")
            .trim();
          let assignedTo = wiObj.fields["System.AssignedTo"]?.uniqueName;

          let states = config.ado.states;
          let state = Object.keys(states).find(
            (k) => states[k] === wiObj.fields["System.State"]
          );

          log.debug(
            `[WORKITEM: ${workItem.id} / ISSUE: ${issue_number}] Title:`,
            title
          );
          log.debug(
            `[WORKITEM: ${workItem.id} / ISSUE: ${issue_number}] Body:`,
            body
          );
          log.debug(
            `[WORKITEM: ${workItem.id} / ISSUE: ${issue_number}] State:`,
            state
          );

          const ghAssignedTo = assignedTo
            ? this.objectFlip(config.ado.mappings?.handles ?? {})?.[
                assignedTo.toLowerCase()
              ]
            : null;
          log.debug(
            `[WORKITEM: ${workItem.id} / ISSUE: ${issue_number}] AssignedTo:`,
            `${assignedTo}/${ghAssignedTo}`
          );
          if (
            title !== issue.title ||
            body !== issue.body ||
            state !== issue.state ||
            ghAssignedTo?.toLowerCase() !== issue.assignee?.login?.toLowerCase()
          ) {
            let result = await octokit.rest.issues.update({
              owner,
              repo,
              issue_number,
              title,
              body,
              state,
              assignees: ghAssignedTo ? [ghAssignedTo] : [],
            });

            log.debug(
              `[WORKITEM: ${workItem.id} / ISSUE: ${issue_number}] Update:`,
              result
            );
            log.debug(
              `[WORKITEM: ${workItem.id} / ISSUE: ${issue_number}] Issue updated.`
            );

            return result;
          } else {
            log.debug(
              `[WORKITEM: ${workItem.id} / ISSUE: ${issue_number}] Nothing has changed, so skipping.`
            );

            return null;
          }
        } else {
          log.debug(
            `[WORKITEM: ${
              workItem.id
            } / ISSUE: ${issue_number}] WorkItem.ChangedDate (${new Date(
              wiObj.fields["System.ChangedDate"]
            )}) is less recent than Issue.UpdatedAt (${new Date(
              issue.updated_at
            )}). Skipping issue update...`
          );

          return null;
        }
      });
  }
};
