export interface KernelPtyIntegrationEnvironment {
  readonly nodePtyAvailable: boolean;
  readonly substrate?: string;
}

/** The Linux gate Pod cannot verify the host kernel PTY resize contract. */
export function shouldSkipKernelPtyIntegration({ nodePtyAvailable, substrate }: KernelPtyIntegrationEnvironment): boolean {
  return !nodePtyAvailable || substrate === 'pod';
}
