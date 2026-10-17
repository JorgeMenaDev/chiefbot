import { DisksClient, InstancesClient, ZoneOperationsClient, type protos } from "@google-cloud/compute";

export type Instance = protos.google.cloud.compute.v1.IInstance;
export type Disk = protos.google.cloud.compute.v1.IDisk;

// The slice of the Compute Engine API that GceProvider needs, in one zone.
// Mutations resolve once their operation is done. Failures throw an error with
// the API's `httpStatusCode` (404 missing, 409 already exists), as
// @google-cloud/compute does. Tests use fakeCompute instead.
export type ComputeClient = {
  insertDisk(disk: Disk): Promise<void>;
  deleteDisk(name: string): Promise<void>;
  // Creates and boots a VM. Fields in `instance` replace the template's.
  insertInstance(instance: Instance, sourceInstanceTemplate: string): Promise<void>;
  getInstance(name: string): Promise<Instance>;
  startInstance(name: string): Promise<void>;
  stopInstance(name: string): Promise<void>;
  deleteInstance(name: string): Promise<void>;
};

// The real ComputeClient. Credentials come from Application Default
// Credentials: on the control VM, its service account. Never used in tests.
export function googleCompute({ project, zone }: { project: string; zone: string }): ComputeClient {
  const instances = new InstancesClient();
  const disks = new DisksClient();
  const operations = new ZoneOperationsClient();

  // Waits for a zonal operation to finish and throws its error, if any.
  async function done(started: Promise<[{ latestResponse: { name?: string | null } }, ...unknown[]]>) {
    const [{ latestResponse }] = await started;
    const operation = latestResponse.name ?? "";
    for (;;) {
      const [result] = await operations.wait({ project, zone, operation });
      if (result.status !== "DONE") continue;
      const errors = result.error?.errors ?? [];
      if (errors.length > 0) throw new Error(`Compute operation ${operation} failed: ${JSON.stringify(errors)}`);
      return;
    }
  }

  return {
    insertDisk: (diskResource) => done(disks.insert({ project, zone, diskResource })),
    deleteDisk: (disk) => done(disks.delete({ project, zone, disk })),
    insertInstance: (instanceResource, sourceInstanceTemplate) =>
      done(instances.insert({ project, zone, instanceResource, sourceInstanceTemplate })),
    getInstance: async (instance) => (await instances.get({ project, zone, instance }))[0],
    startInstance: (instance) => done(instances.start({ project, zone, instance })),
    stopInstance: (instance) => done(instances.stop({ project, zone, instance })),
    deleteInstance: (instance) => done(instances.delete({ project, zone, instance })),
  };
}
