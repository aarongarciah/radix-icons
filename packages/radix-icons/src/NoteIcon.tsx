import * as React from 'react';
import { BaseIconProps } from './types';

interface NoteIconProps extends BaseIconProps {
  size?: '25';
  type?: 'outline';
}

export const NoteIcon = ({
  color = 'currentColor',
  size = '25',
  type = 'outline',
  ...props
}: NoteIconProps) => {
  if (type === 'outline' && size === '25') {
    return (
      <svg width="25" height="25" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
        <path
          d="M18 5.5H7A1.5 1.5 0 0 0 5.5 7v11A1.5 1.5 0 0 0 7 19.5h11a1.5 1.5 0 0 0 1.5-1.5V7A1.5 1.5 0 0 0 18 5.5zM9 9.5h7M9 12.5h7M9 15.5h7"
          stroke={color}
        />
      </svg>
    );
  }

  console.error(`NoteIcon doesn't support the combination of ${size} and ${type}`);
  return null;
};

export default NoteIcon;
