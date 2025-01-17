import * as React from 'react';
import { BaseIconProps } from './types';

interface DevicePrintIconProps extends BaseIconProps {
  size?: '25';
  type?: 'outline';
}

export const DevicePrintIcon = ({
  color = 'currentColor',
  size = '25',
  type = 'outline',
  ...props
}: DevicePrintIconProps) => {
  if (type === 'outline' && size === '25') {
    return (
      <svg width="25" height="25" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
        <path
          d="M16 15.5H9A1.5 1.5 0 0 0 7.5 17v2A1.5 1.5 0 0 0 9 20.5h7a1.5 1.5 0 0 0 1.5-1.5v-2a1.5 1.5 0 0 0-1.5-1.5zM7.5 6A1.5 1.5 0 0 1 9 4.5h7A1.5 1.5 0 0 1 17.5 6v5.5h-10V6z"
          stroke={color}
        />
        <path
          d="M7.5 18.5H6A1.5 1.5 0 0 1 4.5 17v-4A1.5 1.5 0 0 1 6 11.5h13a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-1.5"
          stroke={color}
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  console.error(`DevicePrintIcon doesn't support the combination of ${size} and ${type}`);
  return null;
};

export default DevicePrintIcon;
