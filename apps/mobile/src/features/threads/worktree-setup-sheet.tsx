import type { ReactElement } from "react";
import { AppSheet } from "../../components/AppSheet";

export interface WorktreeSetupSheetProps {
  children: ReactElement;
  height: number;
  onClose: () => void;
}

export function WorktreeSetupSheet({ children, onClose }: WorktreeSetupSheetProps) {
  return (
    <AppSheet title="Workspace setup" onClose={onClose}>
      {children}
    </AppSheet>
  );
}
