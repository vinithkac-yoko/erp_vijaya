import { requireUser } from '@/server/auth/session';
import { allFormsFor, launcherFor } from '@/lib/launcher/launcher';
import { Shell } from '@/components/shell/shell';

export default async function Home() {
  const user = await requireUser();
  // Built on the server from the role, never from the model. Per-user "top used first" arrives with the audit log.
  return <Shell user={{ name: user.name, role: user.role, theme: user.theme }} launcher={launcherFor(user.role)} allForms={allFormsFor(user.role)} />;
}
