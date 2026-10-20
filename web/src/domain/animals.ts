import type { AnimalSpec, PetEventType, SessionPhase } from "./types";

const animalIds = [
  "bear",
  "capybara",
  "cat",
  "chameleon",
  "cheeta",
  "cow",
  "dog",
  "duck",
  "fox",
  "hamster",
  "hedgehog",
  "hippo",
  "monkey",
  "octopus",
  "otter",
  "owl",
  "panda",
  "parrot",
  "peacock",
  "penguin",
  "pig",
  "rabbit",
  "racoon",
  "rhino",
  "rooster",
  "seal",
  "sheep",
  "sloth",
  "snake",
  "turtle",
] as const;

export function animalForId(id: string): AnimalSpec {
  const safeId = animalIds.find((animalId) => animalId === id) ?? "cat";
  return {
    id: safeId,
    displayName: safeId[0].toUpperCase() + safeId.slice(1),
    artAssetPath: `/assets/animals/${safeId}.png`,
    platformAssetPath: `/assets/platforms/${safeId}-platform.png`,
  };
}

export const animalCatalog: readonly AnimalSpec[] = animalIds.map(animalForId);

export function randomAnimal(): AnimalSpec {
  return animalCatalog[Math.floor(Math.random() * animalCatalog.length)];
}

export function isLifecycleEvent(event: PetEventType): boolean {
  return (
    event !== "pet_pet" &&
    event !== "drink_water" &&
    event !== "move_or_stretch"
  );
}

export function nextPhaseFor(
  event: PetEventType,
  phase: SessionPhase,
): SessionPhase | null {
  switch (event) {
    case "start_focus_session":
      return phase === "idle" || phase === "focus" ? "focus" : null;
    case "pause_focus_session":
    case "resume_focus_session":
      return phase === "focus" ? phase : null;
    case "complete_focus_session":
    case "stop_focus_session_early":
      return phase === "focus" || phase === "idle" ? "idle" : null;
    case "start_break":
      return phase === "idle" || phase === "break" ? "break" : null;
    case "complete_break":
    case "stop_break_early":
      return phase === "break" || phase === "idle" ? "idle" : null;
    default:
      return phase;
  }
}

export function pendingSpeechFor(event: PetEventType): string {
  const speech: Record<PetEventType, string> = {
    start_focus_session: "I am getting into focus mode with you…",
    pause_focus_session: "I am settling in while you take a breather…",
    resume_focus_session: "I am leaning back into focus with you…",
    complete_focus_session: "I am lining up a proper win for you…",
    stop_focus_session_early: "I am finding something gentle to say…",
    start_break: "I am easing into break mode with you…",
    complete_break: "I am wrapping up that break with you…",
    stop_break_early: "I am adjusting to the shorter break…",
    pet_pet: "…",
    drink_water: "…",
    move_or_stretch: "…",
  };
  return speech[event];
}
