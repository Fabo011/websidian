import { IsIn } from 'class-validator';
import type { PlanTier } from '../../config/configuration';

/** A paid plan the user can subscribe to via Stripe checkout. */
export type PaidPlan = Extract<PlanTier, 'plus'>;

export class CheckoutDto {
  @IsIn(['plus'])
  plan: PaidPlan;
}
