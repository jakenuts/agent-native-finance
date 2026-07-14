const rawAppName = "finance";
const rawAppTitle = "Finance";

const APP_NAME_PLACEHOLDER = "{" + "{APP_NAME}}";
const APP_TITLE_PLACEHOLDER = "{" + "{APP_TITLE}}";

export const APP_NAME =
  rawAppName === APP_NAME_PLACEHOLDER ? "finance" : rawAppName;

export const APP_TITLE =
  rawAppTitle === APP_TITLE_PLACEHOLDER ? "Finance" : rawAppTitle;
