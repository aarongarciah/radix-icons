import * as React from 'react';
import { BaseIconProps } from './types';

interface TextAlignRightIconProps extends BaseIconProps {
  size?: '25';
  type?: 'outline';
}

export const TextAlignRightIcon = ({
  color = 'currentColor',
  size = '25',
  type = 'outline',
  ...props
}: TextAlignRightIconProps) => {
  if (type === 'outline' && size === '25') {
    return (
      <svg width="25" height="25" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
        <path d="M12 16.5h9M4 12.5h17M12 8.5h9" stroke={color} />
      </svg>
    );
  }

  console.error(`TextAlignRightIcon doesn't support the combination of ${size} and ${type}`);
  return null;
};

export default TextAlignRightIcon;
