import { invokePetCommand } from "./backend";
import { requireConfig } from "./config";
import { getSupabaseClient } from "./supabase";

export interface PetAnimal {
  id: string;
  displayName: string;
}

export async function ensurePet(
  animal: PetAnimal,
  expectedUserId?: string,
): Promise<void> {
  await invokePetCommand(
    getSupabaseClient(),
    requireConfig(),
    {
      action: "ensure_pet",
      animal_id: animal.id,
      animal_name: animal.displayName,
    },
    expectedUserId,
  );
}

/** Keep requestId unchanged when retrying the same reset. */
export async function resetPet(
  animal: PetAnimal,
  requestId: string,
  expectedUserId?: string,
): Promise<void> {
  await invokePetCommand(
    getSupabaseClient(),
    requireConfig(),
    {
      action: "reset_pet",
      animal_id: animal.id,
      animal_name: animal.displayName,
      request_id: requestId,
    },
    expectedUserId,
  );
}
