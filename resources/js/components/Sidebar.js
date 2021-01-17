/**
 *
 */
import React, {Fragment} from 'react';
import ReactDOM from 'react-dom';

class Sidebar extends React.Component {

    constructor(props) {
        super(props);
    }

    render() {
        return (
            <Fragment>
                <h3>Menu</h3>
                <a href={APP_URL}>
                    <i className="fas fa-folder-open"/>
                    <span> Projects</span>
                </a>
                <a href={APP_URL}>
                    <i className="fas fa-clock"/>
                    <span> Recent</span>
                </a>
                <a href={APP_URL}>
                    <i className="fas fa-cog"/>
                    <span> Settings</span>
                </a>
            </Fragment>
        );
    }
}

export default Sidebar;

if (document.getElementById('sidebar')) {
    ReactDOM.render(<Sidebar/>, document.getElementById('sidebar'));
}
