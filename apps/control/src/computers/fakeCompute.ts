import type { ComputeClient, Disk, Instance } from "./compute.ts";

// An in-memory Compute Engine zone for GceProvider tests. It answers like the
// real API: a VM boots on insert, inserting a name twice is 409, a missing
// resource is 404, names must be RFC 1035 (lowercase, digits and dashes, at
// most 63 characters), disks given at insert replace the template's (so they must
// include a boot disk), and a disk attached to a VM cannot be attached or deleted again.
export function fakeCompute() {
  const instances = new Map<string, { request: Instance; template: string; status: string }>();
  const disks = new Map<string, Disk>();

  const fail = (httpStatusCode: number, message: string) => Object.assign(new Error(message), { httpStatusCode });
  const validName = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
  const checkName = (name: string) => {
    if (!validName.test(name)) throw fail(400, `invalid resource name ${name}`);
  };
  const lastSegment = (url: string) => url.split("/").at(-1) ?? "";
  const attachedTo = (diskName: string) =>
    [...instances.entries()].find(([, { request }]) =>
      request.disks?.some((disk) => disk.source && lastSegment(disk.source) === diskName),
    )?.[0];
  const get = (name: string) => {
    const instance = instances.get(name);
    if (!instance) throw fail(404, `instance ${name} not found`);
    return instance;
  };

  const client: ComputeClient = {
    async insertDisk(disk) {
      const name = disk.name ?? "";
      checkName(name);
      if (disks.has(name)) throw fail(409, `disk ${name} already exists`);
      disks.set(name, disk);
    },
    async deleteDisk(name) {
      if (!disks.has(name)) throw fail(404, `disk ${name} not found`);
      if (attachedTo(name)) throw fail(400, `disk ${name} is in use by ${attachedTo(name)}`);
      disks.delete(name);
    },
    async insertInstance(request, template) {
      const name = request.name ?? "";
      checkName(name);
      if (instances.has(name)) throw fail(409, `instance ${name} already exists`);
      if (request.disks && !request.disks.some((disk) => disk.boot)) throw fail(400, "a VM needs a boot disk");
      for (const disk of request.disks ?? []) {
        if (!disk.source) continue;
        const diskName = lastSegment(disk.source);
        if (!disks.has(diskName)) throw fail(404, `disk ${diskName} not found`);
        if (attachedTo(diskName)) throw fail(400, `disk ${diskName} is in use by ${attachedTo(diskName)}`);
      }
      instances.set(name, { request, template, status: "RUNNING" });
    },
    async getInstance(name) {
      const { request, status } = get(name);
      return { ...request, status };
    },
    async startInstance(name) {
      get(name).status = "RUNNING";
    },
    async stopInstance(name) {
      get(name).status = "TERMINATED";
    },
    async deleteInstance(name) {
      get(name);
      instances.delete(name);
    },
  };

  return { client, instances, disks };
}
