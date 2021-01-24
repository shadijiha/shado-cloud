import React from 'react';
import ReactDOM from 'react-dom';

class SearchBar extends React.Component {
    render() {
        return (
            <div className="d-flex justify-content-center">
                <form className="form-inline" method="GET" action={Routes.search}>
                    <input type="hidden" name="_token" value={csrf_token}/>
                    <input className="form-control mr-sm-2" type="search" placeholder="Search"
                           aria-label="Search" name="search"/>
                    <button className="btn btn-light my-2 my-sm-0" type="submit">Search</button>
                </form>
            </div>
        );
    }
}

export default SearchBar;

if (document.getElementById('search_bar')) {
    ReactDOM.render(<SearchBar/>, document.getElementById('search_bar'));
}
