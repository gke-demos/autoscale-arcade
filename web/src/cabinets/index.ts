import type { CabinetId } from '../types';
import { absorber } from './absorber';
import { climber } from './climber';
import { lights } from './lights';
import { metrics } from './metrics';
import { nitro } from './nitro';
import { spot } from './spot';
import { teleporter } from './teleporter';
import type { CabinetModule } from './types';

// Each cabinet lives in its own file (cabinets/<id>.tsx) and exports a CabinetModule.
export const cabinets: Record<CabinetId, CabinetModule> = {
  climber,
  spot,
  teleporter,
  absorber,
  lights,
  nitro,
  metrics,
};
