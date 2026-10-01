import type * as React from 'react';
type IconName = 'message-square' | 'send-horizontal' | 'plus' | 'paperclip' | 'mic' | 'terminal' | 'globe' | 'file-text' | 'folder' | 'brain' | 'clock' | 'zap' | 'plug' | 'history' | 'wrench' | 'settings' | 'search' | 'copy' | 'play' | 'square' | 'check' | 'x' | 'triangle-alert' | 'info' | 'chevron-right' | 'chevron-down' | 'arrow-up' | 'download' | 'external-link' | 'table' | 'image' | 'code';
type Tone = 'neutral' | 'shiba' | 'matcha' | 'info' | 'warning' | 'danger';
type Mood = 'default' | 'happy' | 'thinking' | 'working' | 'sleeping' | 'error';
type Status = 'online' | 'working' | 'waiting' | 'idle' | 'error';
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: 'primary' | 'secondary' | 'quiet' | 'danger'; size?: 'sm' | 'md' | 'lg'; icon?: IconName; iconRight?: IconName; loading?: boolean }
export declare function Button(props: ButtonProps): React.ReactElement;
export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { icon: IconName; label: string; variant?: 'quiet' | 'secondary' | 'primary'; size?: 'sm' | 'md' | 'lg' }
export declare function IconButton(props: IconButtonProps): React.ReactElement;
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> { label?: string; hint?: string; error?: string; icon?: IconName }
export declare function Input(props: InputProps): React.ReactElement;
export interface SwitchProps { label?: string; checked?: boolean; defaultChecked?: boolean; onChange?: (next: boolean) => void; disabled?: boolean }
export declare function Switch(props: SwitchProps): React.ReactElement;
export interface ComposerProps { onSend?: (text: string) => void; onStop?: () => void; busy?: boolean; placeholder?: string; model?: string; defaultValue?: string; /** Makes the model label a button (opens your model menu). */ onModelClick?: () => void; /** The menu's content (a MenuList) while it is open; it floats above the label. */ modelMenu?: React.ReactNode; onModelMenuClose?: () => void }
export declare function Composer(props: ComposerProps): React.ReactElement;
export interface TabsProps { items: { id: string; label: string; count?: number }[]; value?: string; defaultValue?: string; onChange?: (id: string) => void }
export declare function Tabs(props: TabsProps): React.ReactElement;
export interface NavItemProps { label: string; icon?: IconName; active?: boolean; count?: number; href?: string; onClick?: () => void }
export declare function NavItem(props: NavItemProps): React.ReactElement;
export interface BadgeProps { tone?: Tone; dot?: boolean; icon?: IconName; children?: React.ReactNode }
export declare function Badge(props: BadgeProps): React.ReactElement;
export interface AgentStatusProps { status?: Status; label?: string }
export declare function AgentStatus(props: AgentStatusProps): React.ReactElement;
export interface ToastProps { tone?: Tone; title?: string; children?: React.ReactNode; action?: React.ReactNode; onClose?: () => void }
export declare function Toast(props: ToastProps): React.ReactElement;
export interface AvatarProps { kind?: 'agent' | 'user'; size?: number; mood?: Mood; name?: string; status?: Status }
export declare function Avatar(props: AvatarProps): React.ReactElement;
export interface MascotProps { mood?: Mood; size?: number; crop?: boolean; label?: string; className?: string }
export declare function Mascot(props: MascotProps): React.ReactElement;
export interface MessageProps { from?: 'user' | 'agent'; name?: string; time?: string; mood?: Mood; children?: React.ReactNode }
export declare function Message(props: MessageProps): React.ReactElement;
export interface ToolCallProps { tool: string; summary?: string; status?: 'running' | 'done' | 'error' | 'approval'; icon?: IconName; duration?: string; args?: object | string; defaultOpen?: boolean; onApprove?: () => void; onDeny?: () => void; children?: React.ReactNode }
export declare function ToolCall(props: ToolCallProps): React.ReactElement;
export interface ThinkingIndicatorProps { label?: string }
export declare function ThinkingIndicator(props: ThinkingIndicatorProps): React.ReactElement;
export interface CodeBlockProps { language?: string; /** The code: a string, or highlighted spans (then pass the raw text as `code` for Copy). */ children: React.ReactNode; code?: string; filename?: string; /** Wrap long lines instead of scrolling sideways. */ wrap?: boolean; /** Clip tall blocks to this height with a "Show all" control. */ maxHeight?: number | string; /** Extra controls in the bar, before Copy (`sx-code__copy` buttons: Open, Save…). */ actions?: React.ReactNode; className?: string }
export declare function CodeBlock(props: CodeBlockProps): React.ReactElement;
export interface CardProps { icon?: IconName; title?: string; description?: string; action?: React.ReactNode; footer?: React.ReactNode; interactive?: boolean; className?: string; children?: React.ReactNode }
export declare function Card(props: CardProps): React.ReactElement;
export interface TableProps { columns?: React.ReactNode[]; rows: React.ReactNode[][]; align?: ('left' | 'center' | 'right' | null | undefined)[]; dense?: boolean; caption?: React.ReactNode; className?: string }
export declare function Table(props: TableProps): React.ReactElement;
export interface FileChipProps { path: string; name?: string; status?: 'added' | 'modified' | 'deleted' | 'renamed'; meta?: string; icon?: IconName; onClick?: () => void; className?: string }
export declare function FileChip(props: FileChipProps): React.ReactElement;
export interface SheetProps { open: boolean; onClose?: () => void; title?: React.ReactNode; subtitle?: React.ReactNode; icon?: IconName; label?: string; actions?: React.ReactNode; footer?: React.ReactNode; width?: number | string; className?: string; children?: React.ReactNode }
export declare function Sheet(props: SheetProps): React.ReactElement | null;
export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> { label?: string; hint?: string; error?: string; rows?: number; className?: string }
export declare function Textarea(props: TextareaProps): React.ReactElement;
export interface SelectOption { id: string; label: string; hint?: string; icon?: IconName; disabled?: boolean }
export interface SelectProps { id?: string; label?: string; value?: string; options: SelectOption[]; onChange?: (id: string) => void; placeholder?: string; hint?: string; disabled?: boolean; width?: number | string; className?: string }
export declare function Select(props: SelectProps): React.ReactElement;
export interface DialogProps { open: boolean; onClose?: () => void; title?: React.ReactNode; description?: React.ReactNode; icon?: IconName; label?: string; footer?: React.ReactNode; width?: number | string; className?: string; children?: React.ReactNode }
export declare function Dialog(props: DialogProps): React.ReactElement | null;
export interface KbdProps { children: React.ReactNode }
export declare function Kbd(props: KbdProps): React.ReactElement;
export interface IconProps { name: IconName; size?: number; strokeWidth?: number; label?: string; className?: string }
export declare function Icon(props: IconProps): React.ReactElement;
export interface WaveProps { size?: number; duration?: number; delay?: number; label?: string; decorative?: boolean; className?: string; style?: React.CSSProperties }
export declare function Wave(props?: WaveProps): React.ReactElement;
export interface TextShimmerProps { children: string; as?: keyof JSX.IntrinsicElements; duration?: number; spread?: number; className?: string; style?: React.CSSProperties }
export declare function TextShimmer(props: TextShimmerProps): React.ReactElement;
export interface PopoverProps { open: boolean; onClose?: () => void; /** The trigger the panel floats from. */ anchor?: React.ReactNode; align?: 'start' | 'end'; placement?: 'down' | 'up'; role?: string; label?: string; width?: number | string; className?: string; children?: React.ReactNode }
export declare function Popover(props: PopoverProps): React.ReactElement;
export interface MenuItem { id: string; label: string; hint?: string; icon?: IconName; checked?: boolean; disabled?: boolean; tone?: 'default' | 'danger' }
export interface MenuListProps { items: MenuItem[]; onSelect?: (id: string) => void; onClose?: () => void; title?: string; label?: string; className?: string }
export declare function MenuList(props: MenuListProps): React.ReactElement;
export interface MenuProps extends MenuListProps { open: boolean; anchor?: React.ReactNode; align?: 'start' | 'end'; placement?: 'down' | 'up'; width?: number | string }
export declare function Menu(props: MenuProps): React.ReactElement;
/** @deprecated a decorative 14px Wave, kept for compatibility */
export declare function Spinner(props?: { size?: number }): React.ReactElement;
declare global { interface Window { Shibaox: { Button: typeof Button; IconButton: typeof IconButton; Input: typeof Input; Switch: typeof Switch; Composer: typeof Composer; Tabs: typeof Tabs; NavItem: typeof NavItem; Badge: typeof Badge; AgentStatus: typeof AgentStatus; Toast: typeof Toast; Avatar: typeof Avatar; Mascot: typeof Mascot; Message: typeof Message; ToolCall: typeof ToolCall; ThinkingIndicator: typeof ThinkingIndicator; CodeBlock: typeof CodeBlock; Card: typeof Card; Kbd: typeof Kbd; Icon: typeof Icon; Spinner: typeof Spinner; Wave: typeof Wave; TextShimmer: typeof TextShimmer; Popover: typeof Popover; MenuList: typeof MenuList; Menu: typeof Menu; Table: typeof Table; Sheet: typeof Sheet; FileChip: typeof FileChip; Textarea: typeof Textarea; Select: typeof Select; Dialog: typeof Dialog } } }
