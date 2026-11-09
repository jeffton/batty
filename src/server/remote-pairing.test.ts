import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { RemoteAccess } from "./remote-access";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-pairing-"));
  directories.push(directory);
  return { directory, access: await RemoteAccess.open(directory) };
}

it("consumes one invitation atomically, binds both identities, and retries only the identical durable claim", async () => {
  const creator = await fixture();
  const adder = await fixture();
  const third = await fixture();
  const invitation = await creator.access.issueInvitation();
  expect(creator.access.authenticate(invitation.token)).toBeUndefined();
  const claim = await adder.access.beginPairing("https://creator.test/", invitation.token);
  expect(claim).not.toHaveProperty("url");
  const competing = await third.access.beginPairing("https://creator.test/", invitation.token);
  const outcomes = await Promise.allSettled([
    creator.access.claimInvitation(invitation.token, claim),
    creator.access.claimInvitation(invitation.token, competing),
  ]);
  expect(outcomes.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  const identity = await creator.access.claimInvitation(invitation.token, claim);
  expect(creator.access.listInvitations()).toEqual([]);
  expect(creator.access.getConnection(claim.instanceId)).not.toHaveProperty("url");
  expect(creator.access.authenticate(invitation.token)).toBeUndefined();
  expect(creator.access.authenticate(claim.remoteToken)?.id).toBe(identity.grantId);
  expect(creator.access.authenticate(claim.localToken)).toBeUndefined();
  await expect(
    creator.access.claimInvitation(invitation.token, {
      ...claim,
      instanceId: third.access.identity().instanceId,
    }),
  ).rejects.toThrow("already been used");

  // A lost HTTPS response or process restart must reuse the same two scoped credentials.
  const reopenedAdder = await RemoteAccess.open(adder.directory);
  expect(await reopenedAdder.beginPairing("https://creator.test/", invitation.token)).toEqual(
    claim,
  );
  const reopenedCreator = await RemoteAccess.open(creator.directory);
  expect(await reopenedCreator.claimInvitation(invitation.token, claim)).toEqual(identity);
  const id = await reopenedAdder.completePairing(
    "https://creator.test/",
    invitation.token,
    identity,
  );
  expect(
    await reopenedAdder.completePairing("https://creator.test/", invitation.token, identity),
  ).toBe(id);
  expect(reopenedAdder.completedPairing("https://creator.test/", invitation.token)).toBe(true);
  expect(reopenedAdder.authenticate(claim.localToken)?.id).toBe(claim.localGrantId);
  expect(reopenedAdder.authenticate(claim.remoteToken)).toBeUndefined();
  expect(JSON.stringify(reopenedCreator.listConnections())).not.toContain(claim.localToken);
  expect(JSON.stringify(reopenedAdder.listConnections())).not.toContain(claim.remoteToken);
  expect(JSON.stringify(reopenedCreator.listConnections())).not.toContain("Hash");
  await reopenedAdder.removeConnection(id);
  expect(reopenedAdder.authenticate(claim.localToken)).toBeUndefined();
  await reopenedCreator.removeConnection(claim.instanceId);
  expect(reopenedCreator.authenticate(claim.remoteToken)).toBeUndefined();
  expect(reopenedCreator.canClaim(invitation.token)).toBe(false);
});

it("does not let a new invitation overwrite an existing paired identity", async () => {
  const creator = await fixture();
  const adder = await fixture();
  const first = await creator.access.issueInvitation();
  const claim = await adder.access.beginPairing("https://creator.test/", first.token);
  await creator.access.claimInvitation(first.token, claim);
  const second = await creator.access.issueInvitation();
  await expect(creator.access.claimInvitation(second.token, claim)).rejects.toThrow(
    "already connected",
  );
  expect(creator.access.listConnections()).toHaveLength(1);
  expect(creator.access.listInvitations()).toEqual([{ id: second.id, label: "Unused token" }]);
});
