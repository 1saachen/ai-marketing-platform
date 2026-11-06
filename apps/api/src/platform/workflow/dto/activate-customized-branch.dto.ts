import type {
  ActivateCustomizedBranchRequest,
  CustomizedInformationMode,
} from '@ai-marketing/contracts';
import { IsIn, IsOptional } from 'class-validator';
export class ActivateCustomizedBranchDto implements ActivateCustomizedBranchRequest {
  @IsOptional()
  @IsIn(['CURRENT', 'HISTORICAL', 'PRESERVE'])
  informationMode?: CustomizedInformationMode;
}
