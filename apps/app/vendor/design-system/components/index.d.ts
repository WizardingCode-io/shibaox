import type * as React from 'react';

type IconName =
  | 'message-square'
  | 'send-horizontal'
  | 'plus'
  | 'paperclip'
  | 'mic'
  | 'terminal'
  | 'globe'
  | 'file-text'
  | 'folder'
  | 'brain'
  | 'clock'
  | 'zap'
  | 'plug'
  | 'history'
  | 'wrench'
  | 'settings'
  | 'search'
  | 'copy'
  | 'play'
  | 'square'
  | 'check'
  | 'x'
  | 'triangle-alert'
  | 'info'
  | 'chevron-right'
  | 'chevron-down'
  | 'arrow-up';
type Tone = 'neutral' | 'shiba' | 'matcha' | 'info' | 'warning' | 'danger';
type Mood = 'default' | 'happy' | 'thinking' | 'working' | 'sleeping' | 'error';
type Status = 'online' | 'working' | 'waiting' | 'idle' | 'error';
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
}
export declare function Button(props: ButtonProps): React.ReactElement;
export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label: string;
  variant?: 'quiet' | 'secondary' | 'primary';
  size?: 'sm' | 'md' | 'lg';
}
export declare function IconButton(props: IconButtonProps): React.ReactElement;
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  icon?: IconName;
}
export declare function Input(props: InputProps): React.ReactElement;
export interface SwitchProps {
  label?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
}
export declare function Switch(props: SwitchProps): React.ReactElement;
export interface ComposerProps {
  onSend?: (text: string) => void;
  onStop?: () => void;
  busy?: boolean;
  placeholder?: string;
  model?: string;
  defaultValue?: string;
}
export declare function Composer(props: ComposerProps): React.ReactElement;
export interface TabsProps {
  items: { id: string; label: string; count?: number }[];
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
}
export declare function Tabs(props: TabsProps): React.ReactElement;
export interface NavItemProps {
  label: string;
  icon?: IconName;
  active?: boolean;
  count?: number;
  href?: string;
  onClick?: () => void;
}
export declare function NavItem(props: NavItemProps): React.ReactElement;
export interface BadgeProps {
  tone?: Tone;
  dot?: boolean;
  icon?: IconName;
  children?: React.ReactNode;
}
export declare function Badge(props: BadgeProps): React.ReactElement;
export interface AgentStatusProps {
  status?: Status;
  label?: string;
}
export declare function AgentStatus(props: AgentStatusProps): React.ReactElement;
export interface ToastProps {
  tone?: Tone;
  title?: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  onClose?: () => void;
}
export declare function Toast(props: ToastProps): React.ReactElement;
export interface AvatarProps {
  kind?: 'agent' | 'user';
  size?: number;
  mood?: Mood;
  name?: string;
  status?: Status;
}
export declare function Avatar(props: AvatarProps): React.ReactElement;
export interface MascotProps {
  mood?: Mood;
  size?: number;
  crop?: boolean;
  label?: string;
  className?: string;
}
export declare function Mascot(props: MascotProps): React.ReactElement;
export interface MessageProps {
  from?: 'user' | 'agent';
  name?: string;
  time?: string;
  mood?: Mood;
  children?: React.ReactNode;
}
export declare function Message(props: MessageProps): React.ReactElement;
export interface ToolCallProps {
  tool: string;
  summary?: string;
  status?: 'running' | 'done' | 'error' | 'approval';
  icon?: IconName;
  duration?: string;
  args?: object | string;
  defaultOpen?: boolean;
  onApprove?: () => void;
  onDeny?: () => void;
  children?: React.ReactNode;
}
export declare function ToolCall(props: ToolCallProps): React.ReactElement;
export interface ThinkingIndicatorProps {
  label?: string;
}
export declare function ThinkingIndicator(props: ThinkingIndicatorProps): React.ReactElement;
export interface CodeBlockProps {
  language?: string;
  children: string;
}
export declare function CodeBlock(props: CodeBlockProps): React.ReactElement;
export interface CardProps {
  icon?: IconName;
  title?: string;
  description?: string;
  action?: React.ReactNode;
  footer?: React.ReactNode;
  interactive?: boolean;
  className?: string;
  children?: React.ReactNode;
}
export declare function Card(props: CardProps): React.ReactElement;
export interface KbdProps {
  children: React.ReactNode;
}
export declare function Kbd(props: KbdProps): React.ReactElement;
export interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  label?: string;
  className?: string;
}
export declare function Icon(props: IconProps): React.ReactElement;
export interface WaveProps {
  size?: number;
  duration?: number;
  delay?: number;
  label?: string;
  decorative?: boolean;
  className?: string;
  style?: React.CSSProperties;
}
export declare function Wave(props?: WaveProps): React.ReactElement;
export interface TextShimmerProps {
  children: string;
  as?: keyof JSX.IntrinsicElements;
  duration?: number;
  spread?: number;
  className?: string;
  style?: React.CSSProperties;
}
export declare function TextShimmer(props: TextShimmerProps): React.ReactElement;
/** @deprecated a decorative 14px Wave, kept for compatibility */
export declare function Spinner(props?: { size?: number }): React.ReactElement;
declare global {
  interface Window {
    Shibaox: {
      Button: typeof Button;
      IconButton: typeof IconButton;
      Input: typeof Input;
      Switch: typeof Switch;
      Composer: typeof Composer;
      Tabs: typeof Tabs;
      NavItem: typeof NavItem;
      Badge: typeof Badge;
      AgentStatus: typeof AgentStatus;
      Toast: typeof Toast;
      Avatar: typeof Avatar;
      Mascot: typeof Mascot;
      Message: typeof Message;
      ToolCall: typeof ToolCall;
      ThinkingIndicator: typeof ThinkingIndicator;
      CodeBlock: typeof CodeBlock;
      Card: typeof Card;
      Kbd: typeof Kbd;
      Icon: typeof Icon;
      Spinner: typeof Spinner;
      Wave: typeof Wave;
      TextShimmer: typeof TextShimmer;
    };
  }
}
