import type { SubmitRequest } from '@shibaox/daemon';
import { Text } from 'ink';

export interface NewRunFormProps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  onSubmit: (req: SubmitRequest) => Promise<string | undefined>;
  onCancel: () => void;
  onDone: (runId: string) => void;
}

/** Placeholder until Task 6 implements the form. */
export function NewRunForm(_props: NewRunFormProps) {
  return <Text>New run form</Text>;
}
