import { supportedEffort, type Project, type SetBotModelRequest } from "@chiefbot/contracts";
import { EffortPicker, useModels } from "./BotComposerControls.tsx";
import { ComposerControlSeparator } from "./ComposerControl.tsx";
import { ModelPicker } from "./ModelPicker.tsx";

// The project composer's footer controls: the model the project's agent runs on,
// among the user's plan's models, then (when the model takes one) its reasoning
// effort. A pick is the project's, for every member's next turn. `onSaved` runs
// once control saved it; control's refusal goes to `onError`.
export function ProjectComposerControls({
  project,
  onSaved,
  onError,
}: {
  project: Project;
  onSaved: () => void;
  onError: (message: string | null) => void;
}) {
  const { models, refresh } = useModels();
  const model = models.find(({ id }) => id === project.model);
  const efforts = model?.efforts ?? [];
  // A saved effort the model no longer offers runs as its default, as control sends it.
  const effort = supportedEffort(efforts, project.effort);

  async function setModel(request: SetBotModelRequest) {
    onError(null);
    try {
      await window.chiefbot.projects.setModel(project.id, request);
      onSaved();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <>
      <ModelPicker model={project.model} models={models} onOpen={refresh} onPick={({ id }) => void setModel({ model: id })} />
      {efforts.length > 0 && (
        <>
          <ComposerControlSeparator />
          <EffortPicker
            efforts={efforts}
            effort={effort}
            defaultEffort={model?.defaultEffort ?? null}
            onChange={(next) => void setModel({ model: project.model, effort: next })}
          />
        </>
      )}
    </>
  );
}
