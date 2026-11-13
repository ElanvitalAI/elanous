// The app_deploy route is supplied by the host's native handler declared in
// plugin.json. Keep a valid activation entry so onRoute can load this package.
const appDeploy = {
  name: 'elanous-app-deploy',
  version: '0.3.9',
  description: 'Build, simulate and publish a registered Elanous app through the shared app lifecycle.',
  initialState: () => ({}),
  panes: {},
};

export default appDeploy;
